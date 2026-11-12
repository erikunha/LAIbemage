/**
 * Fetch the VisA subset (spec 003, US1 / task 1.2).
 *
 * ## What this script does
 *
 * It downloads the VisA release archive, verifies it against
 * `datasets/registry.json`, extracts the selected object classes (parts), and
 * writes a per-file manifest. It is a **manual tool**: nothing else in the
 * repository calls it, and CI never runs it (see {@link CI_ENV} below).
 *
 * ```bash
 * pnpm tsx scripts/datasets/fetch-visa.ts --check          # verify, never download
 * pnpm tsx scripts/datasets/fetch-visa.ts                   # download + verify + extract
 * pnpm tsx scripts/datasets/fetch-visa.ts --offline         # use the local cache only
 * pnpm tsx scripts/datasets/fetch-visa.ts --record-checksums
 * ```
 *
 * ## The rules it obeys
 *
 *  - **The license gate first.** The registry entry must carry a non-empty
 *    license before a single byte is fetched (the constitution's data
 *    governance rule).
 *  - **The checksum is computed, never assumed.** The archive is a multipart
 *    S3 upload, so its ETag is *not* an MD5 and *not* a checksum. The script
 *    computes the sha256 of the bytes it received and compares it with the
 *    pinned value; the registry stays unpinned (`sha256: null`) until a real
 *    fetch pins it with `--record-checksums`.
 *  - **Disk before network.** The archive is ~1.93 GB and the extraction needs
 *    headroom, so the free space is checked *before* the download starts and
 *    the run is refused with the numbers it would have needed.
 *  - **Resumable.** An interrupted download continues with an HTTP `Range`
 *    request; the sha256 is still computed in one pass over the bytes.
 *  - **Partial extraction.** Only the selected parts are written. The tar is
 *    sequential, so the reader stops as soon as the selected parts are
 *    complete — unless the archive turns out not to be laid out part by part,
 *    in which case the script says so and finishes the extraction.
 *  - **Path traversal is refused.** Every entry path is sanitised before it
 *    is written; an archive containing `../` entries is rejected.
 *  - **Writes stay inside the datasets directory.** Nothing is written
 *    anywhere else — in particular never into `input/` or `output/`.
 *
 * ## The testability seam
 *
 * Every network call goes through {@link HttpFetcher}, which the default
 * implementation fulfils with the global `fetch`. A test injects its own
 * fetcher and the whole script runs without a network — the same seam
 * pattern the store uses for its `DriverFactory`.
 */

import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertDatasetUsable,
  findDataset,
  loadDatasetRegistry,
  recordChecksums,
  type DatasetRegistry,
  type DatasetRegistryEntry,
} from '../../packages/core/src/benchmark/registry.js';
import { VISA_DEFECT_TAXONOMY } from '../../packages/core/src/benchmark/normalize.js';

/** The repository root (this file lives in `<repo>/scripts/datasets/`). */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The tracked registry of datasets. */
export const REGISTRY_PATH = path.join(REPO_ROOT, 'datasets', 'registry.json');

/** The datasets directory the script reads from and writes to. */
export const DATASETS_DIR = path.join(REPO_ROOT, 'datasets');

/** The id of the VisA subset in the registry. */
export const VISA_SUBSET_ID = 'visa-subset';

/** The marker file that proves a staged dataset is complete. */
const READY_MARKER = '.dataset-ready';

/** The per-file manifest of the staged subset. */
const MANIFEST_NAME = 'manifest.json';

/** The CI marker: when this is set, the script refuses to download. */
export const CI_ENV = 'CI';

/** Every object class of the VisA release (the dataset's own class list). */
export const VISA_PARTS: readonly string[] = Object.keys(VISA_DEFECT_TAXONOMY).sort();

/** How much room the extraction is assumed to need, as a multiple of the archive. */
export const DEFAULT_EXTRACTION_FACTOR = 1;

/** The HTTP surface the script needs — injectable, so tests need no network. */
export interface HttpResponseLike {
  /** The HTTP status code. */
  readonly status: number;
  /** The response headers. */
  readonly headers: { get(name: string): string | null };
  /** The response body, or `null` when there is none. */
  readonly body: AsyncIterable<Uint8Array> | null;
}

/** The one network call the script makes. */
export type HttpFetcher = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<HttpResponseLike>;

/** The default fetcher: the global `fetch`. */
export const defaultFetcher: HttpFetcher = async (url, init) => {
  const response = await fetch(url, init);
  return {
    status: response.status,
    headers: response.headers,
    body: response.body as AsyncIterable<Uint8Array> | null,
  };
};

/** The free-space probe — injectable, so the precheck is testable. */
export type DiskSpaceProbe = (directory: string) => Promise<{ available: number; total: number }>;

/** The default probe: `fs.statfs`. */
export const defaultDiskSpaceProbe: DiskSpaceProbe = async (directory) => {
  const stats = await statfs(directory);
  return { available: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) };
};

/** The options of one fetch run. */
export interface FetchOptions {
  /** The registry file to read. */
  readonly registryPath?: string;
  /** The datasets directory to read from and write to. */
  readonly datasetsDir?: string;
  /** The dataset id to fetch. */
  readonly datasetId?: string;
  /** The object classes to extract. Defaults to the registry's selection. */
  readonly parts?: readonly string[];
  /** Verify only; never download. */
  readonly check?: boolean;
  /** Use only the local cache; never download. */
  readonly offline?: boolean;
  /** Write the computed sha256 into the registry. */
  readonly recordChecksums?: boolean;
  /** The fetcher to use. */
  readonly fetcher?: HttpFetcher;
  /** The disk-space probe to use. */
  readonly diskSpaceProbe?: DiskSpaceProbe;
  /** The clock, injectable for deterministic tests. */
  readonly now?: () => Date;
}

/** The result of one fetch run. */
export interface FetchResult {
  /** What the run did. */
  readonly action: 'checked' | 'fetched' | 'offline';
  /** Whether the run ended successfully. */
  readonly ok: boolean;
  /** The message a human reads. */
  readonly message: string;
  /** The sha256 of the archive, when it was computed. */
  readonly archiveSha256?: string;
  /** The number of extracted files. */
  readonly files?: number;
  /** The object classes that were extracted. */
  readonly parts?: readonly string[];
  /** Whether the extraction stopped early (the selected parts were complete). */
  readonly stoppedEarly?: boolean;
}

/** The parsed command line. */
export interface ParsedArgs {
  readonly check: boolean;
  readonly offline: boolean;
  readonly recordChecksums: boolean;
  readonly parts?: readonly string[];
  readonly datasetId?: string;
  readonly registryPath?: string;
  readonly datasetsDir?: string;
}

/** Parses the command line of the script. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  let check = false;
  let offline = false;
  let recordChecksums = false;
  let parts: string[] | undefined;
  let datasetId: string | undefined;
  let registryPath: string | undefined;
  let datasetsDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--check':
        check = true;
        break;
      case '--offline':
        offline = true;
        break;
      case '--record-checksums':
        recordChecksums = true;
        break;
      case '--parts': {
        const value = argv[index + 1];
        if (!value) throw new Error('--parts needs a comma-separated list of object classes');
        parts = value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
        index += 1;
        break;
      }
      case '--dataset': {
        const value = argv[index + 1];
        if (!value) throw new Error('--dataset needs a dataset id');
        datasetId = value.trim();
        index += 1;
        break;
      }
      case '--registry': {
        const value = argv[index + 1];
        if (!value) throw new Error('--registry needs a path');
        registryPath = path.resolve(value);
        index += 1;
        break;
      }
      case '--datasets-dir': {
        const value = argv[index + 1];
        if (!value) throw new Error('--datasets-dir needs a path');
        datasetsDir = path.resolve(value);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown argument '${arg}'`);
    }
  }
  return { check, offline, recordChecksums, parts, datasetId, registryPath, datasetsDir };
}

/** One file of the staged subset, as recorded in the manifest. */
export interface ManifestFile {
  /** The path relative to the subset directory. */
  readonly path: string;
  /** The size in bytes. */
  readonly bytes: number;
  /** The sha256 of the file. */
  readonly sha256: string;
}

/** The per-file manifest of the staged subset. */
export interface SubsetManifest {
  /** The dataset id. */
  readonly datasetId: string;
  /** The dataset version. */
  readonly version: string;
  /** The archive the subset was extracted from. */
  readonly archive: {
    readonly url: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly etag: string | null;
  };
  /** The object classes in the subset. */
  readonly parts: readonly string[];
  /** Every staged file. */
  readonly files: readonly ManifestFile[];
}

/**
 * Refuses to write outside the datasets directory.
 *
 * @throws {Error} when the target escapes the datasets directory.
 */
export function assertInsideDatasetsDir(datasetsDir: string, target: string): string {
  const root = path.resolve(datasetsDir);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write outside the datasets directory: '${resolved}'`);
  }
  return resolved;
}

/**
 * The number of bytes the run needs on disk.
 *
 * The archive itself plus the room the extraction is assumed to need.
 */
export function computeRequiredBytes(
  entry: DatasetRegistryEntry,
  extractionFactor: number = DEFAULT_EXTRACTION_FACTOR,
): { archive: number; extraction: number; total: number } {
  const archive = entry.archiveBytes ?? 0;
  const extraction = Math.ceil(archive * extractionFactor);
  return { archive, extraction, total: archive + extraction };
}

/**
 * Checks the free space of the target volume.
 *
 * @throws {Error} when the volume cannot hold the run.
 */
export async function assertDiskSpace(
  directory: string,
  required: number,
  probe: DiskSpaceProbe = defaultDiskSpaceProbe,
): Promise<{ available: number; required: number }> {
  const { available } = await probe(directory);
  if (available < required) {
    throw new Error(
      `Not enough disk space in '${directory}': ${formatBytes(available)} available, ` +
        `${formatBytes(required)} required (archive + extraction headroom). ` +
        'Free space, or point --datasets-dir at a larger volume.',
    );
  }
  return { available, required };
}

/** Formats a byte count for a human. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** The sha256 of a file on disk. */
export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * The start offset declared by a `Content-Range` header.
 *
 * `bytes 100-199/1000` → `100`. A header the script cannot read yields
 * `null`, which the caller treats as a mismatch (an unverifiable resume is
 * not a safe resume).
 */
export function parseContentRangeStart(contentRange: string | null): number | null {
  if (contentRange === null) return null;
  const match = /^\s*bytes\s+(\d+)-(\d+)\/(?:\d+|\*)\s*$/i.exec(contentRange);
  if (match === null) return null;
  const start = Number.parseInt(match[1] as string, 10);
  return Number.isFinite(start) ? start : null;
}

/**
 * Downloads the archive, computing its sha256 while the bytes stream in.
 *
 * The download resumes: when a partial file exists, the request carries a
 * `Range` header and the bytes are appended. The sha256 stays a single pass
 * over the file — the already-downloaded prefix is hashed from disk first, so
 * the digest covers the whole file and the archive is never read twice.
 *
 * @throws {Error} when the download fails or the digest does not match the
 *   pinned value (the message names the offending file).
 */
export async function downloadArchive(input: {
  readonly url: string;
  readonly targetPath: string;
  readonly partialPath: string;
  readonly expectedSha256?: string | null;
  readonly fetcher: HttpFetcher;
}): Promise<{ sha256: string; bytes: number; resumed: boolean }> {
  const { url, targetPath, partialPath, fetcher } = input;

  let existingBytes = 0;
  try {
    existingBytes = (await stat(partialPath)).size;
  } catch {
    existingBytes = 0;
  }

  const headers: Record<string, string> = {};
  if (existingBytes > 0) {
    headers['Range'] = `bytes=${existingBytes}-`;
  }

  const response = await fetcher(url, { headers });
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`Download of '${url}' failed with HTTP ${response.status}`);
  }

  // A 206 answers a range request, but it must answer THE range we asked
  // for. A server that resumes from a different offset would make the
  // prefix and the body two different files silently concatenated — and while
  // the registry is still unpinned, no digest would catch it. The declared
  // start offset is therefore verified before a single byte is appended.
  if (response.status === 206) {
    const declaredStart = parseContentRangeStart(response.headers.get('content-range'));
    if (existingBytes > 0 && declaredStart !== existingBytes) {
      throw new Error(
        `Refusing to resume '${targetPath}': the server answered the range request with ` +
          `Content-Range starting at ${String(declaredStart)}, but ${existingBytes} bytes are ` +
          'already on disk. Delete the partial file and retry the download from scratch.',
      );
    }
    if (existingBytes === 0) {
      throw new Error(
        `Refusing to resume '${targetPath}': the server answered with HTTP 206 but no range ` +
          'was requested. Delete the partial file and retry.',
      );
    }
  }

  const resumed = response.status === 206 && existingBytes > 0;
  if (!resumed && existingBytes > 0) {
    // The server ignored the range: start over rather than concatenate.
    existingBytes = 0;
  }

  const hash = createHash('sha256');
  if (existingBytes > 0) {
    await hashFileInto(partialPath, hash);
  }

  const out = createWriteStream(partialPath, { flags: existingBytes > 0 ? 'a' : 'w' });
  let bytes = existingBytes;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        hash.update(chunk as Buffer);
        bytes += chunk.byteLength;
        if (!out.write(chunk)) {
          await new Promise<void>((resolve) => out.once('drain', () => resolve()));
        }
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
  }

  const sha256 = hash.digest('hex');
  if (input.expectedSha256 && input.expectedSha256 !== sha256) {
    throw new Error(
      `Checksum mismatch for '${targetPath}': expected sha256 ${input.expectedSha256}, got ${sha256}. ` +
        'The download is not the pinned archive — delete the partial file and retry.',
    );
  }

  await rename(partialPath, targetPath);
  return { sha256, bytes, resumed };
}

/** Feeds the bytes of a file into a running hash. */
async function hashFileInto(filePath: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
}

/** One entry of a tar archive. */
interface TarEntry {
  /** The entry path, as recorded in the archive. */
  readonly name: string;
  /** The size of the entry payload. */
  readonly size: number;
  /** The type flag: `0` (file), `5` (directory), … */
  readonly type: string;
}

/**
 * Reads the entries of a tar archive, one after another.
 *
 * The reader is deliberately minimal: it understands the ustar format, GNU
 * long names (`L`) and pax extended headers (`x`), which is what a `tar`
 * written by a modern `tar` produces.
 *
 * The archive is read through a single {@link ByteSource}, so the header and
 * the payload of an entry can never drift apart — the payload of an entry is
 * always the bytes that follow its header, never a later chunk of the stream.
 */
export async function* readTarEntries(
  stream: AsyncIterable<Buffer>,
): AsyncGenerator<{ entry: TarEntry; payload: Buffer }> {
  const source = new ByteSource(stream);
  let pendingLongName: string | null = null;
  let pendingPaxPath: string | null = null;

  for (;;) {
    const headerBlock = await source.readBlock(512);
    if (headerBlock === null) break;
    if (headerBlock.every((byte) => byte === 0)) continue; // the end-of-archive marker

    const name = readString(headerBlock, 0, 100);
    const size = readOctal(headerBlock, 124, 12);
    const type = String.fromCharCode(headerBlock[156] ?? 48);
    const prefix = readString(headerBlock, 345, 155);
    const magic = readString(headerBlock, 257, 6);

    // The payload follows its header immediately, and every payload is padded
    // to a multiple of the block size.
    const payload = await source.read(size);
    const padding = (512 - (size % 512)) % 512;
    if (padding > 0) await source.read(padding);

    if (type === 'L') {
      pendingLongName = payload.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (type === 'x' || type === 'X') {
      const pax = payload.toString('utf8');
      const match = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(pax);
      if (match?.[1]) pendingPaxPath = match[1];
      continue;
    }

    const fullName =
      pendingPaxPath ??
      pendingLongName ??
      (prefix.length > 0 && magic.startsWith('ustar') ? `${prefix}/${name}` : name);
    pendingLongName = null;
    pendingPaxPath = null;

    yield { entry: { name: fullName, size, type }, payload };
  }
}

/**
 * The single reader of the archive.
 *
 * A tar is a sequential format: the header of an entry is followed by its
 * payload. Reading both from two independent consumers of the same stream
 * would lose whatever the first consumer had already buffered, so the archive
 * is read through this one source.
 */
class ByteSource {
  /** The iterator over the raw stream. */
  private readonly iterator: AsyncIterator<Buffer>;

  /** The bytes that were read but not consumed yet. */
  private buffer: Buffer = Buffer.alloc(0);

  /** Whether the stream has ended. */
  private ended = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  /**
   * Reads exactly `size` bytes.
   *
   * @throws {Error} when the stream ends before `size` bytes are available.
   */
  async read(size: number): Promise<Buffer> {
    while (this.buffer.length < size) {
      if (!(await this.fill())) break;
    }
    if (this.buffer.length < size) {
      throw new Error(
        `Truncated tar archive: expected ${size} bytes, ${this.buffer.length} available`,
      );
    }
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return out;
  }

  /**
   * Reads one block of `size` bytes.
   *
   * @returns the block, or `null` when the stream has ended.
   */
  async readBlock(size: number): Promise<Buffer | null> {
    while (this.buffer.length < size) {
      if (!(await this.fill())) break;
    }
    if (this.buffer.length === 0) return null;
    const take = Math.min(size, this.buffer.length);
    const out = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    return out;
  }

  /** Pulls the next chunk of the stream into the buffer. */
  private async fill(): Promise<boolean> {
    if (this.ended) return false;
    const next = await this.iterator.next();
    if (next.done) {
      this.ended = true;
      return false;
    }
    const chunk = Buffer.from(next.value);
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    return true;
  }
}

/** Reads a NUL-terminated string field of a tar header. */
function readString(header: Buffer, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8');
}

/** Reads an octal numeric field of a tar header. */
function readOctal(header: Buffer, offset: number, length: number): number {
  const field = readString(header, offset, length).trim();
  if (field.length === 0) return 0;
  const value = Number.parseInt(field, 8);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Refuses an archive entry path that is absolute or that traverses upwards.
 *
 * Every entry of the archive is checked — not only the entries of the
 * selected parts — so a malicious archive is refused as a whole instead of
 * being silently ignored because the entry happened to belong to a part that
 * was not selected.
 *
 * @throws {Error} when the entry path is unsafe.
 */
export function assertSafeEntryName(entryName: string): void {
  const normalized = entryName.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    throw new Error(`Refusing the absolute archive path '${entryName}'`);
  }
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.some((segment) => segment === '..')) {
    throw new Error(`Refusing the traversing archive path '${entryName}'`);
  }
}

/**
 * Resolves an archive entry path against the subset directory.
 *
 * **Every path is sanitised.** An absolute path, a `..` segment or a path
 * that resolves outside the target directory is refused — an archive is
 * untrusted input, and a `../` entry would otherwise write outside the
 * datasets directory.
 *
 * @throws {Error} when the entry path escapes the target directory.
 */
export function safeExtractPath(targetDir: string, entryName: string): string {
  assertSafeEntryName(entryName);
  const normalized = entryName.replace(/\\/g, '/');
  const segments = normalized.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  const resolved = path.resolve(targetDir, ...segments);
  const relative = path.relative(path.resolve(targetDir), resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing the escaping archive path '${entryName}'`);
  }
  return resolved;
}

/** The object class an archive entry belongs to, or `null` when it belongs to none. */
export function partOfEntry(entryName: string): { root: string | null; part: string } {
  const segments = entryName.replace(/\\/g, '/').split('/').filter((segment) => segment.length > 0);
  if (segments.length < 2) return { root: null, part: segments[0] ?? '' };
  if (segments[0] === 'VisA') {
    return { root: 'VisA', part: segments[1] ?? '' };
  }
  if (!VISA_PARTS.includes(segments[0] ?? '') && VISA_PARTS.includes(segments[1] ?? '')) {
    return { root: segments[0] ?? null, part: segments[1] ?? '' };
  }
  return { root: null, part: segments[0] ?? '' };
}

/** The outcome of one extraction. */
export interface ExtractionResult {
  /** The extracted files, relative to the subset directory. */
  readonly files: readonly ManifestFile[];
  /** Whether the reader stopped before the end of the archive. */
  readonly stoppedEarly: boolean;
  /** Whether the archive was laid out part by part (so an early stop is possible). */
  readonly groupedByPart: boolean;
}

/**
 * Extracts the selected object classes out of the archive.
 *
 * The tar is sequential, so the extraction stops as soon as every selected
 * part has been seen — provided the archive really is laid out part by part.
 * When it is not (a selected part shows up after a part that sorts later), the
 * script cannot stop early; it says so and finishes the archive.
 *
 * @throws {Error} when an entry path escapes the target directory.
 */
export async function extractParts(input: {
  readonly archivePath: string;
  readonly targetDir: string;
  readonly parts: readonly string[];
}): Promise<ExtractionResult> {
  const { archivePath, targetDir, parts } = input;
  const selected = [...parts].sort();
  const lastSelected = selected[selected.length - 1] ?? '';

  await mkdir(targetDir, { recursive: true });

  const files: ManifestFile[] = [];
  const seenParts = new Set<string>();
  let stoppedEarly = false;
  let groupedByPart = true;
  let passedLastSelected = false;

  const stream = createReadStream(archivePath);
  for await (const { entry, payload } of readTarEntries(stream)) {
    // Every entry is checked, even the ones of parts that are not selected:
    // a traversal path is a refusal of the whole archive, not a detail of the
    // part that happens to contain it.
    assertSafeEntryName(entry.name);

    const { part } = partOfEntry(entry.name);

    if (!selected.includes(part)) {
      // A part that sorts after the last selected one means the selected
      // parts are complete — but only if the archive is grouped by part.
      if (part > lastSelected && selected.every((name) => seenParts.has(name))) {
        stoppedEarly = true;
        break;
      }
      if (passedLastSelected && selected.some((name) => !seenParts.has(name))) {
        groupedByPart = false;
      }
      continue;
    }

    if (passedLastSelected) {
      // The same part shows up again after a later part: the archive is not
      // grouped, so an early stop would have missed files.
      groupedByPart = false;
    }

    if (entry.type === '5') {
      const directory = safeExtractPath(targetDir, entry.name);
      await mkdir(directory, { recursive: true });
      seenParts.add(part);
      continue;
    }
    if (entry.type !== '0' && entry.type !== '\0' && entry.type !== '') {
      // Symlinks, hard links, devices: never extracted.
      continue;
    }

    const destination = safeExtractPath(targetDir, entry.name);
    await mkdir(path.dirname(destination), { recursive: true });
    const hash = createHash('sha256');
    hash.update(payload);
    await writeFile(destination, payload);
    files.push({
      path: path.relative(targetDir, destination).split(path.sep).join('/'),
      bytes: payload.byteLength,
      sha256: hash.digest('hex'),
    });
    seenParts.add(part);
    if (part === lastSelected) passedLastSelected = true;
  }

  return { files, stoppedEarly: stoppedEarly && groupedByPart, groupedByPart };
}

/**
 * Verifies the staged subset against its manifest.
 *
 * @returns the list of problems; an empty list means the subset is intact.
 */
export async function verifySubset(
  subsetDir: string,
  manifest: SubsetManifest,
): Promise<{ problems: string[]; checked: number }> {
  const problems: string[] = [];
  let checked = 0;
  for (const file of manifest.files) {
    const target = path.join(subsetDir, file.path);
    let actual: string;
    try {
      actual = await sha256OfFile(target);
    } catch {
      problems.push(`${file.path}: the file is missing`);
      continue;
    }
    checked += 1;
    if (actual !== file.sha256) {
      problems.push(`${file.path}: sha256 mismatch (expected ${file.sha256}, got ${actual})`);
    }
  }
  return { problems, checked };
}

/** Reads the manifest of a staged subset. */
export async function readManifest(subsetDir: string): Promise<SubsetManifest | null> {
  try {
    const text = await readFile(path.join(subsetDir, MANIFEST_NAME), 'utf8');
    return JSON.parse(text) as SubsetManifest;
  } catch {
    return null;
  }
}

/**
 * Runs the fetch script.
 *
 * This is the whole behaviour of the script, expressed as one function so it
 * can be exercised without a network and without a terminal.
 */
export async function runFetch(options: FetchOptions = {}): Promise<FetchResult> {
  const registryPath = options.registryPath ?? REGISTRY_PATH;
  const datasetsDir = options.datasetsDir ?? DATASETS_DIR;
  const datasetId = options.datasetId ?? VISA_SUBSET_ID;
  const fetcher = options.fetcher ?? defaultFetcher;
  const diskSpaceProbe = options.diskSpaceProbe ?? defaultDiskSpaceProbe;
  const now = options.now ?? (() => new Date());

  const registry: DatasetRegistry = await loadDatasetRegistry(registryPath);
  const entry = findDataset(registry, datasetId);

  // The constitutional gate: no license, no use.
  assertDatasetUsable(entry);

  const parts = options.parts && options.parts.length > 0 ? [...options.parts].sort() : entry.parts.selected;
  if (parts.length === 0) {
    throw new Error(`The registry entry '${entry.id}' selects no object classes`);
  }

  const subsetDir = assertInsideDatasetsDir(datasetsDir, path.join(datasetsDir, entry.id));
  const cacheDir = assertInsideDatasetsDir(datasetsDir, path.join(datasetsDir, 'cache'));
  const archiveName = path.basename(new URL(entry.resource).pathname) || 'visa.tar';
  const archivePath = assertInsideDatasetsDir(datasetsDir, path.join(cacheDir, archiveName));
  const partialPath = `${archivePath}.part`;

  // --- --check: verify the local copy, never download -----------------------
  if (options.check) {
    if (entry.sha256 === null) {
      return {
        action: 'checked',
        ok: false,
        message:
          `The registry entry '${entry.id}' is unpinned — run the fetch to pin it ` +
          '(its sha256 is null until a real download computes it).',
      };
    }
    const problems: string[] = [];
    let archiveChecked = false;
    try {
      const actual = await sha256OfFile(archivePath);
      archiveChecked = true;
      if (actual !== entry.sha256) {
        problems.push(
          `${archiveName}: sha256 mismatch (expected ${entry.sha256}, got ${actual})`,
        );
      }
    } catch {
      problems.push(`${archiveName}: the archive is not in the local cache`);
    }

    const manifest = await readManifest(subsetDir);
    if (manifest) {
      const subset = await verifySubset(subsetDir, manifest);
      problems.push(...subset.problems);
    } else {
      problems.push(`${MANIFEST_NAME}: the subset manifest is missing`);
    }

    if (problems.length > 0) {
      return {
        action: 'checked',
        ok: false,
        message: `Verification failed:\n  - ${problems.join('\n  - ')}`,
        archiveSha256: archiveChecked ? entry.sha256 : undefined,
      };
    }
    return {
      action: 'checked',
      ok: true,
      message: `The staged '${entry.id}' matches the pinned sha256 ${entry.sha256}.`,
      archiveSha256: entry.sha256,
    };
  }

  // --- --offline: the local cache only, never download ----------------------
  if (options.offline) {
    try {
      await stat(archivePath);
    } catch {
      return {
        action: 'offline',
        ok: false,
        message:
          `The archive '${archiveName}' is not in the local cache ('${cacheDir}'). ` +
          'Offline mode never downloads: run the fetch once with a network, or restore the archive by hand.',
      };
    }
  }

  if (process.env[CI_ENV] && !options.offline) {
    throw new Error(
      `Refusing to download while ${CI_ENV} is set: datasets are never fetched automatically in CI. ` +
        'Run the fetch locally, or use --check to verify an existing copy.',
    );
  }

  // --- Disk precheck, before any network call ------------------------------
  const required = computeRequiredBytes(entry);
  await assertDiskSpace(datasetsDir, required.total, diskSpaceProbe);

  // --- Download (unless offline) --------------------------------------------
  let archiveSha256: string | undefined;
  if (!options.offline) {
    await mkdir(cacheDir, { recursive: true });
    const download = await downloadArchive({
      url: entry.resource,
      targetPath: archivePath,
      partialPath,
      expectedSha256: entry.sha256,
      fetcher,
    });
    archiveSha256 = download.sha256;
  } else {
    archiveSha256 = await sha256OfFile(archivePath);
    if (entry.sha256 !== null && archiveSha256 !== entry.sha256) {
      throw new Error(
        `Checksum mismatch for '${archivePath}': expected sha256 ${entry.sha256}, got ${archiveSha256}.`,
      );
    }
  }

  // --- Extract the selected parts -------------------------------------------
  await rm(subsetDir, { recursive: true, force: true });
  await mkdir(subsetDir, { recursive: true });
  const extraction = await extractParts({ archivePath, targetDir: subsetDir, parts });
  if (!extraction.groupedByPart) {
    process.stderr.write(
      'The archive is not laid out part by part, so the extraction could not stop early — the whole archive was read.\n',
    );
  }

  // --- Manifest + marker ----------------------------------------------------
  const manifest: SubsetManifest = {
    datasetId: entry.id,
    version: entry.version,
    archive: {
      url: entry.resource,
      bytes: entry.archiveBytes ?? 0,
      sha256: archiveSha256,
      etag: entry.etag,
    },
    parts,
    files: extraction.files,
  };
  await writeFile(
    path.join(subsetDir, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    path.join(subsetDir, READY_MARKER),
    `${JSON.stringify({ datasetId: entry.id, sha256: archiveSha256, stagedAt: now().toISOString() }, null, 2)}\n`,
    'utf8',
  );

  // --- Pin the checksum -----------------------------------------------------
  if (options.recordChecksums && archiveSha256) {
    await recordChecksums(registryPath, entry.id, archiveSha256, now());
  }

  return {
    action: options.offline ? 'offline' : 'fetched',
    ok: true,
    message:
      `Staged ${extraction.files.length} files of ${parts.join(', ')} in '${subsetDir}' ` +
      `(sha256 ${archiveSha256}${extraction.stoppedEarly ? ', extraction stopped early' : ''}).`,
    archiveSha256,
    files: extraction.files.length,
    parts,
    stoppedEarly: extraction.stoppedEarly,
  };
}

/** The command-line entry point. */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runFetch({
    check: args.check,
    offline: args.offline,
    recordChecksums: args.recordChecksums,
    parts: args.parts,
    datasetId: args.datasetId,
    registryPath: args.registryPath,
    datasetsDir: args.datasetsDir,
  });
  if (result.ok) {
    process.stdout.write(`${result.message}\n`);
    return;
  }
  process.stderr.write(`${result.message}\n`);
  process.exitCode = 1;
}

// Only run when invoked as a script, never when imported by a test.
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
