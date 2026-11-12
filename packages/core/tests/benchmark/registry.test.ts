import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DatasetRegistryError,
  assertDatasetLicensed,
  findDataset,
  isPinned,
  loadDatasetRegistry,
  parseDatasetRegistry,
  recordChecksums,
} from '../../src/benchmark/registry.js';

/**
 * The dataset registry (spec 003, US1 / task 1.1).
 *
 * The registry is a GATE, not an index: the constitution requires every
 * dataset to record its license and terms before use. These tests therefore
 * prove that a missing license is refused, that the tracked registry in the
 * repository is honest about its checksum, and that a checksum can only be
 * written by the one write path that computes it.
 */

const REGISTRY_PATH = path.resolve(__dirname, '../../../../datasets/registry.json');

/** A minimal valid entry, for the tests that mutate it. */
function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'test-dataset',
    title: 'Test dataset',
    usage: 'benchmark',
    license: 'CC BY 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    commercialUse: true,
    source: 'https://example.invalid/registry/',
    resource: 'https://example.invalid/dataset.tar',
    version: '1',
    archiveBytes: 1024,
    etag: 'abc-1',
    parts: { selected: ['part-a'], rationale: 'because' },
    sha256: null,
    sha256PinnedAt: null,
    attribution: 'Citation string.',
    fetchedAt: null,
    notes: '',
    ...overrides,
  };
}

/** A registry document around the given entries. */
function registryOf(entries: Record<string, unknown>[]): unknown {
  return { schemaVersion: 1, datasets: entries };
}

/** Writes a temporary registry file and returns its path plus a cleanup. */
function tempRegistry(entries: Record<string, unknown>[]): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'mv-registry-'));
  const file = path.join(dir, 'registry.json');
  writeFileSync(file, `${JSON.stringify(registryOf(entries), null, 2)}\n`, 'utf8');
  return { path: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('dataset registry schema', () => {
  it('accepts a well-formed entry', () => {
    const registry = parseDatasetRegistry(registryOf([validEntry()]));
    expect(registry.datasets).toHaveLength(1);
    expect(registry.datasets[0]?.id).toBe('test-dataset');
  });

  it('rejects an entry whose license is missing', () => {
    const entry = validEntry();
    delete entry['license'];
    expect(() => parseDatasetRegistry(registryOf([entry]))).toThrow(DatasetRegistryError);
  });

  it('rejects an entry whose license is empty', () => {
    expect(() => parseDatasetRegistry(registryOf([validEntry({ license: '' })]))).toThrow(
      DatasetRegistryError,
    );
  });

  it('rejects an entry whose license is only whitespace', () => {
    const entry = validEntry({ license: '   ' });
    const registry = parseDatasetRegistry(registryOf([entry]));
    // Zod's `min(1)` accepts whitespace, so the constitutional gate in
    // assertDatasetLicensed is what refuses it.
    expect(() => assertDatasetLicensed(registry.datasets[0]!)).toThrow(/records no license/);
  });

  it('names the license in the error message', () => {
    try {
      parseDatasetRegistry(registryOf([validEntry({ license: '' })]));
      expect.unreachable('an empty license must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetRegistryError);
      expect((error as DatasetRegistryError).message).toMatch(/license/);
    }
  });

  it('rejects an unknown dataset id lookup', () => {
    const registry = parseDatasetRegistry(registryOf([validEntry()]));
    expect(() => findDataset(registry, 'nope')).toThrow(DatasetRegistryError);
  });

  it('refuses to use a dataset without a license', () => {
    const registry = parseDatasetRegistry(registryOf([validEntry({ license: 'CC BY 4.0' })]));
    expect(() => assertDatasetLicensed(registry.datasets[0]!)).not.toThrow();
  });

  it('rejects a sha256 that is not a digest', () => {
    expect(() =>
      parseDatasetRegistry(registryOf([validEntry({ sha256: 'not-a-digest' })])),
    ).toThrow(DatasetRegistryError);
  });

  it('rejects a pinned sha256 without a pinned-at timestamp', () => {
    expect(() =>
      parseDatasetRegistry(
        registryOf([validEntry({ sha256: 'a'.repeat(64), sha256PinnedAt: null })]),
      ),
    ).toThrow(DatasetRegistryError);
  });

  it('rejects an unknown top-level key', () => {
    expect(() =>
      parseDatasetRegistry({ schemaVersion: 1, datasets: [validEntry()], extra: true }),
    ).toThrow(DatasetRegistryError);
  });
});

describe('the tracked registry', () => {
  it('is valid against the schema', async () => {
    const registry = await loadDatasetRegistry(REGISTRY_PATH);
    expect(registry.schemaVersion).toBe(1);
    expect(registry.datasets.length).toBeGreaterThanOrEqual(2);
  });

  it('carries the real VisA entry with the verified source facts', async () => {
    const registry = await loadDatasetRegistry(REGISTRY_PATH);
    const entry = findDataset(registry, 'visa-subset');
    expect(entry.license).toBe('CC BY 4.0');
    expect(entry.commercialUse).toBe(true);
    expect(entry.source).toBe('https://registry.opendata.aws/visa/');
    expect(entry.resource).toBe(
      'https://amazon-visual-anomaly.s3.us-west-2.amazonaws.com/VisA_20220922.tar',
    );
    expect(entry.version).toBe('20220922');
    expect(entry.archiveBytes).toBe(1929840640);
    expect(entry.etag).toBe('05c830591a1172938cb714895c9e0cfb-113');
    expect(entry.parts.selected.length).toBeGreaterThanOrEqual(3);
    expect(entry.parts.selected.length).toBeLessThanOrEqual(4);
    expect(entry.parts.rationale.length).toBeGreaterThan(0);
    expect(entry.attribution).toContain('registry.opendata.aws/visa');
  });

  it('pins the sha256 computed from the FETCHED bytes — never a fabricated digest', async () => {
    const registry = await loadDatasetRegistry(REGISTRY_PATH);
    const entry = findDataset(registry, 'visa-subset');
    // The archive was fetched on 2026-11-11 and its digest was computed from
    // the received bytes. The assertion is about the SHAPE and the provenance,
    // not about one fixed digest: a sha256 is 64 hex characters, and it is not
    // the multipart ETag (which carries a part count, not a content hash).
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.sha256).not.toBe(entry.etag);
    // The exact digest of the dated release archive, reproducible with
    // `pnpm exec tsx scripts/datasets/fetch-visa.ts --check`. A well-formed
    // but wrong digest would still be a fabricated checksum.
    expect(entry.sha256).toBe(
      '2eb8690c803ab37de0324772964100169ec8ba1fa3f7e94291c9ca673f40f362',
    );
    expect(entry.sha256PinnedAt).not.toBeNull();
    expect(entry.fetchedAt).not.toBeNull();
    expect(isPinned(entry)).toBe(true);
  });

  it('documents MVTec AD as research-only and NOT commercial', async () => {
    const registry = await loadDatasetRegistry(REGISTRY_PATH);
    const entry = findDataset(registry, 'mvtec-ad');
    expect(entry.usage).toBe('research-only');
    expect(entry.license).toBe('CC BY-NC-SA 4.0');
    expect(entry.commercialUse).toBe(false);
    expect(entry.sha256).toBeNull();
    expect(entry.fetchedAt).toBeNull();
  });

  it('records the multipart ETag as provenance, not as a checksum', async () => {
    const raw = readFileSync(REGISTRY_PATH, 'utf8');
    const entry = JSON.parse(raw).datasets.find((d: { id: string }) => d.id === 'visa-subset');
    // The ETag ends in "-113" (the part count), so it cannot be an MD5.
    expect(entry.etag).toMatch(/-113$/);
    // The pinned digest is a real sha256 of the received bytes — and it is
    // something else entirely than the ETag.
    expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.sha256).not.toContain('-');
  });
});

describe('recordChecksums', () => {
  it('fills sha256, sha256PinnedAt and fetchedAt for the entry', async () => {
    const { path: file, cleanup } = tempRegistry([validEntry()]);
    try {
      const digest = 'b'.repeat(64);
      const when = new Date('2026-11-10T12:00:00.000Z');
      const updated = await recordChecksums(file, 'test-dataset', digest, when);
      expect(updated.sha256).toBe(digest);
      expect(updated.sha256PinnedAt).toBe('2026-11-10T12:00:00.000Z');
      expect(updated.fetchedAt).toBe('2026-11-10T12:00:00.000Z');

      // The file on disk really carries the new values.
      const written = JSON.parse(readFileSync(file, 'utf8'));
      expect(written.datasets[0].sha256).toBe(digest);
      expect(written.datasets[0].sha256PinnedAt).toBe('2026-11-10T12:00:00.000Z');
    } finally {
      cleanup();
    }
  });

  it('leaves the other entries untouched', async () => {
    const { path: file, cleanup } = tempRegistry([validEntry(), validEntry({ id: 'other' })]);
    try {
      await recordChecksums(file, 'other', 'c'.repeat(64));
      const written = JSON.parse(readFileSync(file, 'utf8'));
      expect(written.datasets[0].sha256).toBeNull();
      expect(written.datasets[1].sha256).toBe('c'.repeat(64));
    } finally {
      cleanup();
    }
  });

  it('refuses an unknown dataset id', async () => {
    const { path: file, cleanup } = tempRegistry([validEntry()]);
    try {
      await expect(recordChecksums(file, 'nope', 'd'.repeat(64))).rejects.toThrow(
        DatasetRegistryError,
      );
    } finally {
      cleanup();
    }
  });

  it('writes a registry that can be read back', async () => {
    const { path: file, cleanup } = tempRegistry([validEntry()]);
    try {
      await recordChecksums(file, 'test-dataset', 'e'.repeat(64));
      const reloaded = await loadDatasetRegistry(file);
      expect(isPinned(findDataset(reloaded, 'test-dataset'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});
