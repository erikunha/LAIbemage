/**
 * The config fingerprint of a benchmark run — ADR-008's attribution rule.
 *
 * ## Why this exists
 *
 * A benchmark report is only worth what its reproduction tuple is worth. The
 * tuple names the code snapshot, the split, the model AND the model version
 * — but a model version alone does not say WHICH VOCABULARY the model was
 * asked in, or how the images were preprocessed. Two runs of the same model
 * on the same split with two different taxonomies are two different
 * experiments, and the report must be able to tell them apart.
 *
 * ADR-008 therefore requires the fingerprint to cover the FULL semantic
 * configuration: the model, the prompt template version, the taxonomy WITH
 * its descriptions, the preprocessing, the data version and the contracts
 * version. `fingerprintV2` of `@vision-lens/contracts` hashes exactly that
 * shape, so this module does not invent a digest of its own.
 *
 * ## The taxonomy is not a free choice
 *
 * The taxonomy hashed here is the taxonomy the PREDICTION RUN offers to the
 * model, and that taxonomy is derived from the gold manifest
 * (`benchmark/taxonomy.ts`). It is therefore not an input the operator can
 * get wrong: it is a pure function of the split. Two manifests with different
 * vocabularies produce different fingerprints, and the same manifest always
 * produces the same fingerprint.
 *
 * ## What is NOT in here
 *
 * Routing thresholds, output formatting and reporter choices — they do not
 * change a single per-image answer (the same exclusion `fingerprintV2`
 * documents).
 */

import { CONTRACTS_VERSION, fingerprintV2 } from '@vision-lens/contracts';
import { IMAGE_JPEG_QUALITY, IMAGE_RESIZE_PX } from '../analyzer/batch.js';
import { PROMPT_TEMPLATE_VERSION } from '../analyzer/prompt-version.js';

// Re-exported so the benchmark surface carries the prompt version it hashes.
export { PROMPT_TEMPLATE_VERSION };
import type { SplitManifest } from './splits.js';
import { buildTaxonomy } from './taxonomy.js';

/** The default number of images per LLM call in a benchmark run. */
export const DEFAULT_BENCHMARK_BATCH_SIZE = 20;

/** The inputs of a config fingerprint. */
export interface ConfigFingerprintInput {
  /** The gold split manifest the run was scored against. */
  readonly manifest: SplitManifest;
  /** The provider that served the model, e.g. `openai`. */
  readonly provider: string;
  /** The model id, e.g. `gpt-4o`. */
  readonly model: string;
  /** The versioned model string, e.g. `model:gpt-4o@2024-11-20`. */
  readonly modelVersion: string;
  /** The dataset version the manifest belongs to, e.g. `visa-subset@20220922`. */
  readonly dataVersion: string;
  /** The number of images per LLM call. */
  readonly batchSize?: number;
}

/** The components that were hashed, and the digest they produced. */
export interface ConfigFingerprint {
  /** The fingerprint itself, `fp2:<16 hex>`. */
  readonly fingerprint: string;
  /** Every component that went into the hash, for the human reader. */
  readonly components: {
    readonly model: string;
    readonly promptTemplate: string;
    readonly taxonomy: ReadonlyArray<Record<string, unknown>>;
    readonly preprocessing: Record<string, unknown>;
    readonly dataVersion: string;
    readonly contractsVersion: string;
  };
}

/**
 * Computes the config fingerprint of a benchmark run.
 *
 * Deterministic: the same manifest and the same inputs always produce the
 * same fingerprint. No timestamp, no absolute path and no randomness enters
 * the hash — a fingerprint that changed on every call could not be compared
 * with anything.
 */
export function computeConfigFingerprint(input: ConfigFingerprintInput): ConfigFingerprint {
  const taxonomy = buildTaxonomy(input.manifest);
  // The versioned model string is what identifies the experiment; the
  // provider alone does not (the same model id exists under two providers).
  // The benchmark's own convention wraps the version in `model:<name>@<version>`
  // — the bare version is what the component carries, so the component reads
  // `provider/model@version` whichever form the caller used.
  const version = input.modelVersion.includes('@')
    ? (input.modelVersion.slice(input.modelVersion.lastIndexOf('@') + 1) as string)
    : input.modelVersion;
  const components = {
    model: `${input.provider}/${input.model}@${version}`,
    promptTemplate: PROMPT_TEMPLATE_VERSION,
    // The WHOLE taxonomy, descriptions included: a changed description
    // changes the prompt and therefore the result.
    taxonomy: taxonomy.document.categories.map((category) => ({ ...category })),
    preprocessing: {
      // The image pipeline of the batch analyzer: the images are resized to
      // 768px and re-encoded as JPEG quality 80 before they leave the
      // process, and the provider is asked for the low-detail tile.
      imageResizePx: IMAGE_RESIZE_PX,
      jpegQuality: IMAGE_JPEG_QUALITY,
      detail: 'low',
      batchSize: input.batchSize ?? DEFAULT_BENCHMARK_BATCH_SIZE,
    },
    dataVersion: input.dataVersion,
    contractsVersion: CONTRACTS_VERSION,
  };

  return { fingerprint: fingerprintV2(components), components };
}
