import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeRequiredBytes,
  extractParts,
  safeExtractPath,
  sha256OfFile,
  type HttpFetcher,
  type HttpResponseLike,
} from '../../../../scripts/datasets/fetch-visa.js';
import {
  DATASET_ABSENT_MARKER,
  DATASETS_DIR_ENV,
  datasetAbsentMessage,
  datasetAvailable,
  resolveDatasetsDir,
} from '../../src/benchmark/dataset-availability.js';
import { loadDatasetRegistry } from '../../src/benchmark/registry.js';

/**
 * The fetch script (spec 003, US1 / task 1.2) and the CI availability helper
 * (task 1.4).
 *
 * **No network, ever.** Every test injects its own fetcher, so the whole
 * script is exercised offline. The download is simulated with a real byte
 * stream through the real sha256 code path.
 */

/** The digest of the simulated archive. */
const ARCHIVE_BYTES = Buffer.from('a synthetic archive payload — never downloaded from S3');

/** The digest of the simulated archive. */
const ARCHIVE_SHA256 = createHash('sha256').update(ARCHIVE_BYTES).digest('hex');

/** Builds an HTTP response over a fixed buffer. */
function responseOf(bytes: Buffer, status = 200): HttpResponseLike {
  return {
    status,
    headers: { get: () => null },
    body: (async function* stream() {
      yield bytes;
    })(),
  };
}

/** A fetcher that serves the simulated archive and records its calls. */
function fakeFetcher(
  bytes: Buffer = ARCHIVE_BYTES,
  calls: string[] = [],
): HttpFetcher {
  return async (url, init) => {
    calls.push(`${init?.headers?.['Range'] ?? 'no-range'} ${url}`);
    return responseOf(bytes);
  };
}

/** A temporary directory the caller must remove. */
function makeTempDir(prefix = 'mv-fetch-'): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A registry file with a pinned sha256 and an unpinned one. */
async function writeRegistry(
  dir: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const file = path.join(dir, 'registry.json');
  writeFileSync(file, `${JSON.stringify({ schemaVersion: 1, datasets: entries }, null, 2)}\n`, 'utf8');
  return file;
}

/** A registry entry for the tests. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'visa-subset',
    title: 'VisA subset',
    usage: 'benchmark',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    commercialUse: true,
    source: 'https://registry.opendata.aws/visa/',
    resource: 'https://example.invalid/VisA_20220922.tar',
    version: '20220922',
    archiveBytes: ARCHIVE_BYTES.byteLength,
    etag: 'deadbeef-113',
    parts: { selected: ['candle'], rationale: 'test' },
    sha256: null,
    sha256PinnedAt: null,
    attribution: 'Zou et al., 2022.',
    fetchedAt: null,
    notes: '',
    ...overrides,
  };
}

/**
 * Builds a tar archive in memory.
 *
 * A minimal ustar writer: 512-byte header blocks, padded payloads.
 */
function buildTar(files: readonly { name: string; content: string | Buffer }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(file.name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(`${content.byteLength.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    header.write('ustar\0', 257, 6, 'utf8');
    header.write('00', 263, 2, 'utf8');
    // The checksum field is filled with spaces while the checksum is computed.
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8');
    blocks.push(header, content);
    const padding = (512 - (content.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return Buffer.concat(blocks);
}

describe('the fetch script', () => {
  it('computes the sha256 of the file on disk from the streamed bytes', async () => {
    const dir = makeTempDir();
    try {
      const archive = path.join(dir, 'archive.tar');
      writeFileSync(archive, ARCHIVE_BYTES, 'utf8');
      const digest = await sha256OfFile(archive);
      expect(digest).toBe(ARCHIVE_SHA256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('computes the required disk space from the archive size', () => {
    const required = computeRequiredBytes(
      { archiveBytes: 1000 } as never,
      1,
    );
    expect(required).toEqual({ archive: 1000, extraction: 1000, total: 2000 });
  });

  it('REFUSES the run when the volume lacks the space, before any network call', async () => {
    const dir = makeTempDir();
    try {
      const registryPath = await writeRegistry(dir, [entry()]);
      const { runFetch } = await import('../../../../scripts/datasets/fetch-visa.js');
      const calls: string[] = [];
      await expect(
        runFetch({
          registryPath,
          datasetsDir: dir,
          fetcher: fakeFetcher(ARCHIVE_BYTES, calls),
          // The volume reports almost nothing free.
          diskSpaceProbe: async () => ({ available: 10, total: 10 }),
        }),
      ).rejects.toThrow(/Not enough disk space/);
      // The precheck runs BEFORE the download: no network call was made.
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ABORTS the run when the downloaded bytes do not match the pinned checksum', async () => {
    const dir = makeTempDir();
    try {
      const registryPath = await writeRegistry(dir, [
        entry({ sha256: 'f'.repeat(64), sha256PinnedAt: '2026-11-10T12:00:00.000Z' }),
      ]);
      const { runFetch } = await import('../../../../scripts/datasets/fetch-visa.js');
      await expect(
        runFetch({
          registryPath,
          datasetsDir: dir,
          fetcher: fakeFetcher(ARCHIVE_BYTES),
          diskSpaceProbe: async () => ({ available: 10_000_000, total: 10_000_000 }),
        }),
      ).rejects.toThrow(/Checksum mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports an UNPINNED entry as unpinned on --check, not as success', async () => {
    const dir = makeTempDir();
    try {
      const registryPath = await writeRegistry(dir, [entry({ sha256: null })]);
      const { runFetch } = await import('../../../../scripts/datasets/fetch-visa.js');
      const calls: string[] = [];
      const result = await runFetch({
        registryPath,
        datasetsDir: dir,
        check: true,
        fetcher: fakeFetcher(ARCHIVE_BYTES, calls),
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/unpinned/i);
      expect(result.message).toMatch(/run the fetch to pin it/i);
      // --check never downloads.
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ABORTS with the offending file NAMED when the local file hash differs', async () => {
    const dir = makeTempDir();
    try {
      const registryPath = await writeRegistry(dir, [
        entry({ sha256: ARCHIVE_SHA256, sha256PinnedAt: '2026-11-10T12:00:00.000Z' }),
      ]);
      const cacheDir = path.join(dir, 'cache');
      mkdirSync(cacheDir, { recursive: true });
      // The cached archive does NOT match the pinned digest.
      writeFileSync(path.join(cacheDir, 'VisA_20220922.tar'), 'different bytes', 'utf8');

      const { runFetch } = await import('../../../../scripts/datasets/fetch-visa.js');
      const result = await runFetch({
        registryPath,
        datasetsDir: dir,
        check: true,
        fetcher: fakeFetcher(ARCHIVE_BYTES),
      });
      expect(result.ok).toBe(false);
      // The message names the file that is wrong.
      expect(result.message).toContain('VisA_20220922.tar');
      expect(result.message).toMatch(/sha256 mismatch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with actionable instructions when --offline has no cache', async () => {
    const dir = makeTempDir();
    try {
      const registryPath = await writeRegistry(dir, [entry()]);
      const { runFetch } = await import('../../../../scripts/datasets/fetch-visa.js');
      const calls: string[] = [];
      const result = await runFetch({
        registryPath,
        datasetsDir: dir,
        offline: true,
        fetcher: fakeFetcher(ARCHIVE_BYTES, calls),
      });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/not in the local cache/);
      expect(result.message).toMatch(/never downloads/);
      // Offline mode never reaches the network.
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a dataset without a license', async () => {
    const dir = makeTempDir();
    try {
      const registryPath = await writeRegistry(dir, [entry({ license: '' })]);
      const { runFetch } = await import('../../../../scripts/datasets/fetch-visa.js');
      await expect(
        runFetch({
          registryPath,
          datasetsDir: dir,
          fetcher: fakeFetcher(ARCHIVE_BYTES),
          diskSpaceProbe: async () => ({ available: 10_000_000, total: 10_000_000 }),
        }),
      ).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a dataset recorded as research-only, before any network call', async () => {
    const dir = makeTempDir();
    try {
      const registryPath = await writeRegistry(dir, [
        entry({
          id: 'mvtec-ad',
          usage: 'research-only',
          commercialUse: false,
          license: 'CC BY-NC-SA 4.0',
          parts: { selected: ['bottle'], rationale: 'research only' },
        }),
      ]);
      const { runFetch } = await import('../../../../scripts/datasets/fetch-visa.js');
      const calls: string[] = [];
      await expect(
        runFetch({
          registryPath,
          datasetsDir: dir,
          datasetId: 'mvtec-ad',
          fetcher: fakeFetcher(ARCHIVE_BYTES, calls),
          diskSpaceProbe: async () => ({ available: 10_000_000, total: 10_000_000 }),
        }),
      ).rejects.toThrow(/research-only/);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a dataset whose license forbids commercial use, before any network call', async () => {
    const dir = makeTempDir();
    try {
      const registryPath = await writeRegistry(dir, [
        entry({ license: 'CC BY-NC-SA 4.0', commercialUse: false }),
      ]);
      const { runFetch } = await import('../../../../scripts/datasets/fetch-visa.js');
      const calls: string[] = [];
      await expect(
        runFetch({
          registryPath,
          datasetsDir: dir,
          fetcher: fakeFetcher(ARCHIVE_BYTES, calls),
          diskSpaceProbe: async () => ({ available: 10_000_000, total: 10_000_000 }),
        }),
      ).rejects.toThrow(/commercial use/);
      expect(calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resumes a partial download and hashes the WHOLE file, prefix included', async () => {
    const dir = makeTempDir();
    try {
      const { downloadArchive, parseContentRangeStart } = await import(
        '../../../../scripts/datasets/fetch-visa.js'
      );
      const prefix = ARCHIVE_BYTES.subarray(0, 10);
      const rest = ARCHIVE_BYTES.subarray(10);
      const partialPath = path.join(dir, 'archive.tar.part');
      writeFileSync(partialPath, prefix);

      const calls: string[] = [];
      const result = await downloadArchive({
        url: 'https://example.invalid/archive.tar',
        targetPath: path.join(dir, 'archive.tar'),
        partialPath,
        expectedSha256: ARCHIVE_SHA256,
        fetcher: async (url, init) => {
          calls.push(`${init?.headers?.['Range'] ?? 'no-range'} ${url}`);
          return {
            status: 206,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === 'content-range'
                  ? `bytes ${prefix.byteLength}-${ARCHIVE_BYTES.byteLength - 1}/${ARCHIVE_BYTES.byteLength}`
                  : null,
            },
            body: (async function* stream() {
              yield rest;
            })(),
          };
        },
      });

      expect(calls[0]).toBe(`bytes=10- https://example.invalid/archive.tar`);
      expect(result.resumed).toBe(true);
      // The digest covers the prefix from disk AND the new bytes.
      expect(result.sha256).toBe(ARCHIVE_SHA256);
      expect(parseContentRangeStart('bytes 10-99/100')).toBe(10);
      expect(parseContentRangeStart(null)).toBeNull();
      expect(parseContentRangeStart('garbage')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REFUSES to resume when the server answers from the wrong offset', async () => {
    const dir = makeTempDir();
    try {
      const { downloadArchive } = await import('../../../../scripts/datasets/fetch-visa.js');
      const partialPath = path.join(dir, 'archive.tar.part');
      writeFileSync(partialPath, ARCHIVE_BYTES.subarray(0, 10));

      await expect(
        downloadArchive({
          url: 'https://example.invalid/archive.tar',
          targetPath: path.join(dir, 'archive.tar'),
          partialPath,
          expectedSha256: null,
          fetcher: async () => ({
            status: 206,
            headers: {
              get: (name: string) =>
                name.toLowerCase() === 'content-range' ? 'bytes 500-999/1000' : null,
            },
            body: (async function* stream() {
              yield ARCHIVE_BYTES.subarray(10);
            })(),
          }),
        }),
      ).rejects.toThrow(/Refusing to resume/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to write outside the datasets directory', async () => {
    const { assertInsideDatasetsDir } = await import('../../../../scripts/datasets/fetch-visa.js');
    expect(() => assertInsideDatasetsDir('/tmp/datasets', '/tmp/datasets/visa-subset')).not.toThrow();
    expect(() => assertInsideDatasetsDir('/tmp/datasets', '/tmp/elsewhere/file')).toThrow(
      /outside the datasets directory/,
    );
    expect(() => assertInsideDatasetsDir('/tmp/datasets', '/tmp/datasets/../escape')).toThrow(
      /outside the datasets directory/,
    );
  });

  it('REFUSES a traversing path in the archive', () => {
    expect(() => safeExtractPath('/tmp/out', '../escape.txt')).toThrow(/traversing/);
    expect(() => safeExtractPath('/tmp/out', '/etc/passwd')).toThrow(/absolute/);
    expect(() => safeExtractPath('/tmp/out', 'a/../../b')).toThrow(/traversing/);
    expect(safeExtractPath('/tmp/out', 'candle/Data/Images/Normal/0000.JPG')).toBe(
      path.join('/tmp/out', 'candle/Data/Images/Normal/0000.JPG'),
    );
  });

  it('extracts only the selected parts and stops early', async () => {
    const dir = makeTempDir();
    try {
      const archive = path.join(dir, 'archive.tar');
      writeFileSync(
        archive,
        buildTar([
          { name: 'VisA/candle/Data/Images/Normal/0000.JPG', content: 'candle-normal' },
          { name: 'VisA/candle/Data/Images/Anomaly/000.JPG', content: 'candle-anomaly' },
          { name: 'VisA/candle/image_anno.csv', content: 'image,label,mask\n' },
          { name: 'VisA/capsules/Data/Images/Normal/0000.JPG', content: 'capsules-normal' },
          { name: 'VisA/macaroni1/Data/Images/Normal/0000.JPG', content: 'macaroni-normal' },
        ]),
        'utf8',
      );

      const target = path.join(dir, 'out');
      const result = await extractParts({
        archivePath: archive,
        targetDir: target,
        parts: ['candle', 'capsules'],
      });

      const paths = result.files.map((file) => file.path).sort();
      expect(paths).toContain('VisA/candle/Data/Images/Normal/0000.JPG');
      expect(paths).toContain('VisA/capsules/Data/Images/Normal/0000.JPG');
      // macaroni1 sorts after the last selected part: it was never extracted.
      expect(paths.some((file) => file.includes('macaroni1'))).toBe(false);
      expect(result.stoppedEarly).toBe(true);

      // The extracted bytes are the real ones.
      expect(readFileSync(path.join(target, 'VisA/candle/Data/Images/Normal/0000.JPG'), 'utf8')).toBe(
        'candle-normal',
      );
      // And the manifest records their real sha256.
      const candle = result.files.find((file) => file.path.endsWith('candle/Data/Images/Normal/0000.JPG'));
      expect(candle?.sha256).toBe(
        createHash('sha256').update('candle-normal').digest('hex'),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a traversing entry while extracting', async () => {
    const dir = makeTempDir();
    try {
      const archive = path.join(dir, 'evil.tar');
      writeFileSync(
        archive,
        buildTar([
          { name: 'VisA/candle/Data/Images/Normal/0000.JPG', content: 'ok' },
          { name: '../escaped.txt', content: 'evil' },
        ]),
        'utf8',
      );
      await expect(
        extractParts({
          archivePath: archive,
          targetDir: path.join(dir, 'out'),
          parts: ['candle'],
        }),
      ).rejects.toThrow(/traversing/);
      // Nothing escaped the target directory.
      expect(() => readFileSync(path.join(dir, 'escaped.txt'), 'utf8')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins the checksum into the registry only through the write path', async () => {
    const dir = makeTempDir();
    try {
      const registryPath = await writeRegistry(dir, [entry()]);
      const { runFetch } = await import('../../../../scripts/datasets/fetch-visa.js');
      const result = await runFetch({
        registryPath,
        datasetsDir: dir,
        recordChecksums: true,
        fetcher: fakeFetcher(ARCHIVE_BYTES),
        diskSpaceProbe: async () => ({ available: 10_000_000, total: 10_000_000 }),
        now: () => new Date('2026-11-10T12:00:00.000Z'),
      });
      expect(result.ok).toBe(true);

      const registry = await loadDatasetRegistry(registryPath);
      const pinned = registry.datasets[0];
      expect(pinned?.sha256).toBe(ARCHIVE_SHA256);
      expect(pinned?.sha256PinnedAt).toBe('2026-11-10T12:00:00.000Z');
      expect(pinned?.fetchedAt).toBe('2026-11-10T12:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the registry unpinned when --record-checksums is not given', async () => {
    const dir = makeTempDir();
    try {
      const registryPath = await writeRegistry(dir, [entry()]);
      const { runFetch } = await import('../../../../scripts/datasets/fetch-visa.js');
      await runFetch({
        registryPath,
        datasetsDir: dir,
        fetcher: fakeFetcher(ARCHIVE_BYTES),
        diskSpaceProbe: async () => ({ available: 10_000_000, total: 10_000_000 }),
      });
      const registry = await loadDatasetRegistry(registryPath);
      expect(registry.datasets[0]?.sha256).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the CI availability helper', () => {
  it('reports the dataset as ABSENT when the marker file is missing', () => {
    const dir = makeTempDir();
    try {
      mkdirSync(path.join(dir, 'visa-subset'), { recursive: true });
      const availability = datasetAvailable('visa-subset', { [DATASETS_DIR_ENV]: dir } as NodeJS.ProcessEnv);
      expect(availability.present).toBe(false);
      expect(availability.reason).toMatch(/marker/);
      expect(datasetAbsentMessage(availability)).toContain(DATASET_ABSENT_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the dataset as PRESENT when the marker file exists', () => {
    const dir = makeTempDir();
    try {
      const subset = path.join(dir, 'visa-subset');
      mkdirSync(subset, { recursive: true });
      writeFileSync(path.join(subset, '.dataset-ready'), '{}\n', 'utf8');
      const availability = datasetAvailable('visa-subset', { [DATASETS_DIR_ENV]: dir } as NodeJS.ProcessEnv);
      expect(availability.present).toBe(true);
      expect(availability.reason).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports the dataset as ABSENT when the datasets directory does not exist', () => {
    const availability = datasetAvailable('visa-subset', {
      [DATASETS_DIR_ENV]: '/definitely/not/here',
    } as NodeJS.ProcessEnv);
    expect(availability.present).toBe(false);
    expect(availability.reason).toMatch(/does not exist/);
  });

  it('resolves the datasets directory from the environment variable', () => {
    expect(resolveDatasetsDir({ [DATASETS_DIR_ENV]: '/tmp/somewhere' } as NodeJS.ProcessEnv)).toBe(
      '/tmp/somewhere',
    );
  });

  it('uses the explicit marker string', () => {
    expect(DATASET_ABSENT_MARKER).toBe('dataset=absent');
  });
});
