import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, fingerprintV2, type FingerprintInput } from '@vision-lens/contracts';

import { validateEmbeddingManifest, type EmbeddingRunManifest } from './embedding-manifest.js';

/**
 * The golden parity gate of the vision adapter.
 *
 * The gate compares three things and refuses to write anything: the
 * config fingerprint computed on both sides, the manifest validated
 * against the ratified schema, and every golden vector against the
 * output of the adapter, inside the tolerance the golden file documents.
 *
 * The gate NEVER writes the golden file. A golden file is a committed
 * fact, and a gate that rewrites it is a gate that accepts anything
 * (`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md:22`).
 */

/** The schema version of the golden file this gate reads. */
export const GOLDEN_SCHEMA_VERSION = 1;

/** One golden image: its name, the digest of its bytes and its vector. */
export interface GoldenImage {
  readonly name: string;
  readonly sha256: string;
  readonly vector: readonly number[];
}

/** The tolerance the golden vectors are compared within. */
export interface GoldenTolerance {
  readonly maxAbsoluteDifference: number;
  readonly minCosineSimilarity: number;
  readonly reason: string;
}

/** The golden file: the pinned facts of one model over the golden set. */
export interface VisionGolden {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly model: {
    readonly modelId: string;
    readonly revision: string;
    readonly sourceUri: string;
    readonly weightsDigest: string;
  };
  readonly preprocessing: {
    readonly fingerprint: string;
    readonly components: Record<string, unknown>;
  };
  readonly config: FingerprintInput;
  readonly configFingerprint: string;
  readonly tolerance: GoldenTolerance;
  readonly images: readonly GoldenImage[];
  readonly vectorsDigest: string;
}

/** One parity tier: what it compared and what it found. */
export interface ParityTier {
  readonly name: 'config-fingerprint' | 'manifest' | 'vectors';
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/** The report of the three parity tiers. */
export interface ParityReport {
  readonly ok: boolean;
  readonly tiers: readonly ParityTier[];
  readonly issues: readonly string[];
}

/**
 * The digest of the golden set.
 *
 * The digest covers the name and the file digest of every image and the
 * float32 BYTES of its vector. The bytes, and not the JSON of the
 * numbers, because the two languages write a float differently: the
 * bytes of a float32 are the same on both sides and the JSON is not.
 *
 * The digest is what makes an edited golden file detectable: the gate
 * recomputes it and compares it with the one the file carries.
 */
export function goldenVectorsDigest(images: readonly GoldenImage[]): string {
  return createHash('sha256').update(goldenVectorsBytes(images)).digest('hex');
}

/** The bytes the digest of the golden set covers. */
function goldenVectorsBytes(images: readonly GoldenImage[]): Buffer {
  const parts: Buffer[] = [];
  for (const image of images) {
    parts.push(Buffer.from(`${image.name}\u0000${image.sha256}\u0000`, 'utf8'));
    const vector = image.vector;
    const bytes = Buffer.alloc(vector.length * 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < vector.length; index += 1) {
      view.setFloat32(index * 4, vector[index] ?? 0, true);
    }
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

/**
 * The digest of the CONTENT of the golden file.
 *
 * It covers everything the file asserts, except the moment it was
 * generated: the schema version, the model, the preprocessing, the
 * configuration, the config fingerprint, the tolerance and the images
 * with their vectors.
 *
 * The tolerance is inside the digest on purpose. A tolerance that lives
 * only in the file is a tolerance anybody can widen by editing the file,
 * and a gate that reads its own strength from the file it guards is a
 * gate that guards nothing.
 */
export function goldenContentDigest(golden: VisionGolden): string {
  const content = {
    schemaVersion: golden.schemaVersion,
    model: golden.model,
    preprocessing: golden.preprocessing,
    config: golden.config,
    configFingerprint: golden.configFingerprint,
    tolerance: golden.tolerance,
    images: golden.images.map((image) => ({ name: image.name, sha256: image.sha256 })),
  };
  const parts = [Buffer.from(canonicalJson(content), 'utf8'), goldenVectorsBytes(golden.images)];
  return createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}

/**
 * The digest of the committed golden file, pinned in the code.
 *
 * The pin lives OUTSIDE the golden file on purpose: a digest that travels
 * with the file it protects proves nothing, because whoever edits the
 * file edits the digest too. A change to the golden set is therefore a
 * change to this constant, and that change is a visible diff in the
 * code.
 *
 * The pin is over the CONTENT of the file, so the timestamp of the run
 * does not change it.
 */
export const GOLDEN_CONTENT_DIGEST =
  'f18d9e002614f1a1f3d58aabc178acf7ccc2a06df6100e2ca252b3cf05b53dec';

/**
 * Read the golden file and check its own integrity.
 *
 * @throws Error when the file is not a golden file or when its digest
 *   does not match the vectors it carries.
 */
export function readGolden(path: string): VisionGolden {
  const payload = JSON.parse(readFileSync(path, 'utf8')) as VisionGolden;
  if (payload.schemaVersion !== GOLDEN_SCHEMA_VERSION) {
    throw new Error(
      `the golden file at ${path} carries the schema version ${String(payload.schemaVersion)} and this gate reads ${GOLDEN_SCHEMA_VERSION}`,
    );
  }
  const expected = goldenVectorsDigest(payload.images);
  if (expected !== payload.vectorsDigest) {
    throw new Error(
      `the golden file at ${path} carries the digest ${payload.vectorsDigest} and its vectors digest to ${expected}: the file was edited`,
    );
  }
  const content = goldenContentDigest(payload);
  if (content !== GOLDEN_CONTENT_DIGEST) {
    throw new Error(
      `the golden file at ${path} digests to ${content} and the code pins ${GOLDEN_CONTENT_DIGEST}: the file was edited, and a change to the golden set is a change to the pin in the code`,
    );
  }
  return payload;
}

/** The cosine similarity of two vectors, or NaN when one of them is empty. */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) {
    return Number.NaN;
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return Number.NaN;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** The largest absolute difference between two vectors. */
export function maxAbsoluteDifference(
  left: readonly number[],
  right: readonly number[],
): number {
  let largest = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = Math.abs((left[index] ?? 0) - (right[index] ?? 0));
    if (difference > largest) {
      largest = difference;
    }
  }
  return largest;
}

/** The comparison of one golden vector with the observed one. */
export interface VectorComparison {
  readonly name: string;
  readonly maxAbsoluteDifference: number;
  readonly cosineSimilarity: number;
  readonly ok: boolean;
}

/**
 * Compare one golden vector with the observed one, inside the tolerance.
 */
export function compareVector(
  golden: GoldenImage,
  observed: readonly number[],
  tolerance: GoldenTolerance,
): VectorComparison {
  const difference = maxAbsoluteDifference(golden.vector, observed);
  const similarity = cosineSimilarity(golden.vector, observed);
  const ok =
    difference <= tolerance.maxAbsoluteDifference &&
    (Number.isNaN(similarity) ? false : similarity >= tolerance.minCosineSimilarity);
  return { name: golden.name, maxAbsoluteDifference: difference, cosineSimilarity: similarity, ok };
}

/**
 * Compare the IDENTITY of the manifest with the identity of the golden file.
 *
 * Every field that says WHICH run this is, and not only how it went, is
 * compared: the model, the revision, the source, the digest of the
 * weights, the preprocessing and its fingerprint, the snapshot, the
 * count, the dimension and the digests of the assets, in order. A
 * manifest that describes another model, another preprocessing or another
 * set of images is not the manifest of this golden set, even when it
 * validates against the schema.
 */
export function compareIdentity(
  golden: VisionGolden,
  manifest: EmbeddingRunManifest,
): string[] {
  const issues: string[] = [];
  const compare = (field: string, expected: string | number, observed: string | number): void => {
    if (expected !== observed) {
      issues.push(`${field}: the golden file names ${String(expected)} and the manifest carries ${String(observed)}`);
    }
  };
  compare('modelId', golden.model.modelId, manifest.modelId);
  compare('revision', golden.model.revision, manifest.revision);
  compare('sourceUri', golden.model.sourceUri, manifest.sourceUri);
  compare('weightsDigest', golden.model.weightsDigest, manifest.weightsDigest);
  compare('preprocessingFingerprint', golden.preprocessing.fingerprint, manifest.preprocessingFingerprint);
  compare('snapshotId', golden.config.dataVersion, manifest.snapshotId);
  compare('count', golden.images.length, manifest.count);
  compare('dimension', golden.images[0]?.vector.length ?? 0, manifest.dimension);
  const goldenAssets = golden.images.map((image) => image.sha256);
  if (goldenAssets.join(',') !== manifest.assetSha256.join(',')) {
    issues.push(
      `assetSha256: the golden file names ${goldenAssets.join(',')} and the manifest carries ${manifest.assetSha256.join(',')}`,
    );
  }
  const goldenComponents = canonicalJson(golden.preprocessing.components);
  const manifestComponents = canonicalJson(manifest.preprocessingComponents);
  if (goldenComponents !== manifestComponents) {
    issues.push(
      `preprocessingComponents: the golden file names ${goldenComponents} and the manifest carries ${manifestComponents}`,
    );
  }
  return issues;
}

/**
 * Run the three parity tiers over one artifact.
 *
 * The artifact is the directory the Python side wrote: the manifest and
 * the binary vectors file. The gate reads it and never writes it.
 */
export function runParity(golden: VisionGolden, artifactDirectory: string): ParityReport {
  const tiers: ParityTier[] = [];
  const issues: string[] = [];

  // Tier one: the config fingerprint, computed on both sides.
  const configIssues: string[] = [];
  const computed = fingerprintV2(golden.config);
  if (computed !== golden.configFingerprint) {
    configIssues.push(
      `configFingerprint: the golden file names ${golden.configFingerprint} and this side computed ${computed}`,
    );
  }
  tiers.push({ name: 'config-fingerprint', ok: configIssues.length === 0, issues: configIssues });

  // Tier two: the manifest, validated against the ratified schema.
  const manifestIssues: string[] = [];
  let manifest: EmbeddingRunManifest | undefined;
  const manifestPath = join(artifactDirectory, 'manifest.json');
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    manifestIssues.push(`manifest.json could not be read: ${String(error)}`);
  }
  if (payload !== undefined) {
    const validation = validateEmbeddingManifest(payload);
    if (!validation.ok) {
      manifestIssues.push(...validation.issues);
    } else {
      manifest = validation.manifest;
      manifestIssues.push(...compareIdentity(golden, manifest));
    }
  }
  tiers.push({ name: 'manifest', ok: manifestIssues.length === 0, issues: manifestIssues });

  // Tier three: the golden vectors against the observed ones.
  const vectorIssues: string[] = [];
  const observed = readVectors(artifactDirectory, manifest);
  if (observed === undefined) {
    vectorIssues.push('the vectors file could not be read');
  } else if (observed.length !== golden.images.length) {
    vectorIssues.push(
      `count: the golden file carries ${golden.images.length} vectors and the artifact carries ${observed.length}`,
    );
  } else {
    for (const image of golden.images) {
      const comparison = compareVector(image, observed[golden.images.indexOf(image)] ?? [], golden.tolerance);
      if (!comparison.ok) {
        vectorIssues.push(
          `${comparison.name}: max absolute difference ${comparison.maxAbsoluteDifference} and cosine similarity ${comparison.cosineSimilarity} are outside the tolerance (${golden.tolerance.maxAbsoluteDifference}, ${golden.tolerance.minCosineSimilarity})`,
        );
      }
    }
  }
  tiers.push({ name: 'vectors', ok: vectorIssues.length === 0, issues: vectorIssues });

  for (const tier of tiers) {
    issues.push(...tier.issues);
  }
  return { ok: tiers.every((tier) => tier.ok), tiers, issues };
}

/**
 * Read the vectors of an artifact, as float32 little-endian.
 *
 * The digest of the file is checked against the manifest, so a vectors
 * file that was tampered with is not compared: it is refused.
 */
export function readVectors(
  artifactDirectory: string,
  manifest: EmbeddingRunManifest | undefined,
): number[][] | undefined {
  const path = join(artifactDirectory, 'vectors.f32');
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch {
    return undefined;
  }
  if (manifest !== undefined) {
    const digest = createHash('sha256').update(buffer).digest('hex');
    if (digest !== manifest.vectorsFileDigest) {
      return undefined;
    }
  }
  const dimension = manifest?.dimension ?? 0;
  const count = manifest?.count ?? Math.floor(buffer.length / 4 / Math.max(dimension, 1));
  if (dimension <= 0 || buffer.length !== count * dimension * 4) {
    return undefined;
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const vectors: number[][] = [];
  for (let index = 0; index < count; index += 1) {
    const vector: number[] = [];
    for (let component = 0; component < dimension; component += 1) {
      vector.push(view.getFloat32((index * dimension + component) * 4, true));
    }
    vectors.push(vector);
  }
  return vectors;
}
