import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EMBEDDING_MANIFEST_SCHEMA_VERSION,
  UNKNOWN,
  validateEmbeddingManifest,
} from '../../src/adapter/embedding-manifest.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The manifest of the committed golden artifact. */
const goldenArtifactDir = path.join(
  repoRoot,
  'benchmarks',
  'parity',
  'vision-embed.artifact',
);

const goldenManifest = JSON.parse(
  readFileSync(path.join(goldenArtifactDir, 'manifest.json'), 'utf8'),
) as Record<string, unknown>;

describe('the embedding manifest schema', () => {
  it('accepts the manifest the Python side wrote', () => {
    // The manifest of the committed golden artifact is the real one: it
    // was written by the Python runtime and it has to validate here.
    const validation = validateEmbeddingManifest(goldenManifest);

    expect(validation.ok).toBe(true);
  });

  it('names every field that is missing', () => {
    const validation = validateEmbeddingManifest({ modelId: 'siglip2-base' });

    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.issues.join(' ')).toContain('embeddingRunId');
  });

  it('refuses a manifest with a field nobody knows', () => {
    const validation = validateEmbeddingManifest({ ...goldenManifest, mysteryField: 1 });

    expect(validation.ok).toBe(false);
  });

  it('refuses a manifest whose digest is not a digest', () => {
    const validation = validateEmbeddingManifest({
      ...goldenManifest,
      weightsDigest: 'not-a-digest',
    });

    expect(validation.ok).toBe(false);
  });

  it('refuses a manifest whose fingerprint is not in the fp2 form', () => {
    const validation = validateEmbeddingManifest({
      ...goldenManifest,
      preprocessingFingerprint: 'sha256:abc',
    });

    expect(validation.ok).toBe(false);
  });

  it('refuses a manifest whose schema version it does not speak', () => {
    const validation = validateEmbeddingManifest({
      ...goldenManifest,
      schemaVersion: EMBEDDING_MANIFEST_SCHEMA_VERSION + 1,
    });

    expect(validation.ok).toBe(false);
  });

  it('accepts the unknown value where a measurement may be missing', () => {
    // FR-012: a value that does not exist is `unknown` and never a zero.
    const validation = validateEmbeddingManifest({
      ...goldenManifest,
      latency: { count: 0, p50Ms: UNKNOWN, p95Ms: UNKNOWN, totalMs: UNKNOWN },
      peakMemoryBytes: UNKNOWN,
    });

    expect(validation.ok).toBe(true);
  });

  it('refuses a latency block that is not one', () => {
    const validation = validateEmbeddingManifest({
      ...goldenManifest,
      latency: { count: 0 },
    });

    expect(validation.ok).toBe(false);
  });

  it('refuses a manifest whose dtype is not the one of the contract', () => {
    const validation = validateEmbeddingManifest({ ...goldenManifest, dtype: 'float64' });

    expect(validation.ok).toBe(false);
  });

  it('refuses a manifest that carries a base64 payload of the vectors', () => {
    // The vectors live in a binary file beside the manifest, never in it.
    const validation = validateEmbeddingManifest({
      ...goldenManifest,
      vectors: 'AAAA',
    });

    expect(validation.ok).toBe(false);
  });
});
