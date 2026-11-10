import { createHash } from 'node:crypto';

/**
 * Fingerprint v2: hashes the FULL semantic configuration that determines an
 * analysis result, replacing the name-only categories hash (the defect where
 * changing a category DESCRIPTION left caches stale, spec 002 / ADR-008).
 *
 * Included: model, prompt template version, taxonomy (whole category objects,
 * descriptions included), preprocessing, data version, contracts version.
 * Excluded (documented): routing thresholds (do not change per-image prompts),
 * output formatting flags, reporter choices.
 *
 * Digest = 'fp2:' + first 16 hex of sha256 over canonical JSON
 * (recursively key-sorted; arrays keep order — category order changes the
 * prompt and therefore the result).
 */

export interface FingerprintInput {
  /** Provider-qualified model id, e.g. "openai/gpt-4o" */
  model: string;
  /** Prompt template version constant (bump when prompt text changes) */
  promptTemplate: string;
  /** Whole taxonomy entries; descriptions are load-bearing */
  taxonomy: ReadonlyArray<Record<string, unknown>>;
  /** Preprocessing knobs that alter model input (resize, detail...) */
  preprocessing: Record<string, unknown>;
  /** Dataset identity (snapshot id; 'legacy-v2' pre-snapshots) */
  dataVersion: string;
  /** @master-vision/contracts version */
  contractsVersion: string;
}

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => serialize(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`).join(',')}}`;
}

export function fingerprintV2(input: FingerprintInput): string {
  const digest = createHash('sha256').update(serialize(input)).digest('hex');
  return `fp2:${digest.slice(0, 16)}`;
}
