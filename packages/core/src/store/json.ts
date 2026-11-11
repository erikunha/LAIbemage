/**
 * JSON column convention for the Master Vision store.
 *
 * Every JSON-shaped column (`geometry_json`, `context_json`,
 * `metrics_summary_json`, `lineage_json`, `budget_json`, `tool_calls_json`,
 * `approvals_json`, `agreement_json`, `payload_json`, `config_json`,
 * `results_json`, `categories_json`, `recipe_json`, `exif_sanitized_json`,
 * `region_json`, `snapshot_ids_json`, `source_asset_ids_json`) holds **canonical
 * JSON**: object keys sorted, no insignificant whitespace.
 *
 * Canonicalisation is NOT re-implemented here — it is the very same
 * `canonicalJson` the contracts use for fingerprint v2
 * (`@master-vision/contracts`, plan: "canonical JSON = sorted keys, no
 * whitespace, arrays keep order"). Re-using it means a value written to a
 * JSON column and the same value used in a fingerprint serialize identically,
 * so a fingerprint can be recomputed from the stored row.
 *
 * Conventions:
 *
 *  - **Absent** is `NULL`, never the string `'null'` and never `''`.
 *  - **Present** is the canonical JSON text of the value.
 *  - Arrays keep their order (the order is semantic: `toolCalls` is a
 *    timeline, `sourceAssetIds` is a provenance list).
 *  - Numbers are serialized by `JSON.stringify`, which is float-stable within
 *    Node — the same guarantee the fingerprint spec pins.
 */

import { canonicalJson } from '@master-vision/contracts';

/**
 * Serializes a JSON value for storage, or returns `null` when the value is
 * absent (`undefined` / `null`).
 */
export function toJsonColumn(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return canonicalJson(value);
}

/**
 * Parses a JSON column back into a value, or returns `undefined` when the
 * column is `NULL`.
 */
export function fromJsonColumn<T>(text: string | null | undefined): T | undefined {
  if (text === null || text === undefined) return undefined;
  return JSON.parse(text) as T;
}

/**
 * Serializes a JSON value that the contract marks as required: the column is
 * never `NULL`, and `undefined` is a programming error rather than an
 * absent value.
 */
export function toRequiredJsonColumn(value: unknown, column: string): string {
  if (value === undefined || value === null) {
    throw new TypeError(`Required JSON column '${column}' must not be absent.`);
  }
  return canonicalJson(value);
}
