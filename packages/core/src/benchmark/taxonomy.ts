/**
 * The benchmark taxonomy — the vocabulary a gold split is scored in.
 *
 * ## What this module is
 *
 * A benchmark run asks the model one question: "is this specimen normal, or
 * is it a defective specimen of class X?" The vocabulary that question is
 * asked in is DERIVED FROM THE GOLD SPLIT, never from a hand-written list: a
 * class the gold set does not contain cannot be scored, so it must not be
 * offered to the model.
 *
 * So the taxonomy is a pure function of the manifest:
 *
 * ```text
 * normal                     → 'normal'
 * defect of object class X   → 'defect_X'   (the analyzer's normalised name)
 * ```
 *
 * The COLON form (`defect:X`) is the gold LABEL KEY — the key the benchmark
 * scores under. The UNDERSCORE form (`defect_X`) is the taxonomy NAME — what
 * the model is asked to answer with, because the config schema only accepts
 * `lowercase_snake_case` category names.
 *
 * ## Why it lives here and not in a script
 *
 * Two consumers need the EXACT same taxonomy:
 *
 *  1. the prediction run (`scripts/benchmarks/predict-visa.ts`), which offers
 *     the taxonomy to the model;
 *  2. the config fingerprint (`benchmark/config-fingerprint.ts`), which hashes
 *     it so a report names the taxonomy it was produced with.
 *
 * If the two built their taxonomy independently, a fingerprint could describe
 * a taxonomy the run never used — the silent-staleness defect class ADR-008
 * exists to kill. There is therefore exactly ONE implementation, here, and
 * the script imports it.
 */

import type { SplitAssignment, SplitManifest } from './splits.js';
// The label keys are owned by the normaliser — the taxonomy only CONSUMES
// them, so the two modules cannot drift apart.
import { DEFECT_LABEL_PREFIX, NORMAL_LABEL_KEY } from './normalize.js';

/** The description the taxonomy carries as a whole. */
export const TAXONOMY_DESCRIPTION =
  'Visual anomaly classes of an industrial inspection dataset. Every image belongs to ' +
  'exactly one class: either a defect-free specimen ("normal") or a defective specimen ' +
  'of one named object class ("defect_<object class>"). Choose the defect class only ' +
  'when the object can be identified as that object class AND it shows a defect.';

/**
 * The label key an assignment is scored under.
 *
 * The same rule the CLI's benchmark command applies
 * (`packages/cli/src/commands/benchmark.ts`): a normal image is `normal`, an
 * anomalous one is `defect:<object class>`.
 */
export function labelKeyOf(assignment: SplitAssignment): string {
  return assignment.anomaly === 'normal' ? NORMAL_LABEL_KEY : `${DEFECT_LABEL_PREFIX}${assignment.class}`;
}

/**
 * The taxonomy name of a label key — the name the model is asked to answer
 * with.
 *
 * It mirrors `normalizeCategory` of `packages/core/src/analyzer/batch.ts`:
 * lower-case, every run of non-alphanumeric characters collapsed into `_`,
 * no leading or trailing underscore. The analyzer normalises every category
 * the model returns, so the taxonomy name and the normalised model answer
 * are the same string by construction.
 */
export function taxonomyNameOf(labelKey: string): string {
  return labelKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** One category of the generated taxonomy. */
export interface TaxonomyCategory {
  readonly name: string;
  readonly description: string;
}

/** The generated taxonomy — the `categories.json` of the run. */
export interface TaxonomyDocument {
  readonly description: string;
  readonly categories: readonly TaxonomyCategory[];
}

/** The taxonomy plus the table that maps a taxonomy name back to a label key. */
export interface Taxonomy {
  readonly document: TaxonomyDocument;
  /** Taxonomy name → gold label key (e.g. `defect_capsules` → `defect:capsules`). */
  readonly labelKeyByName: ReadonlyMap<string, string>;
}

/** The description of one label key, as the model sees it. */
function describeLabelKey(labelKey: string): string {
  if (labelKey === NORMAL_LABEL_KEY) {
    return (
      'The image shows a NORMAL, defect-free specimen: the object is intact and shows no ' +
      'defect, damage, contamination or malformation.'
    );
  }
  const objectClass = labelKey.slice(DEFECT_LABEL_PREFIX.length);
  return (
    `The image shows a DEFECTIVE specimen of the '${objectClass}' object class: the object ` +
    `is visibly damaged, malformed, contaminated or otherwise anomalous. Choose this ` +
    `category only when the object can be identified as '${objectClass}'.`
  );
}

/**
 * Builds the taxonomy of a gold manifest.
 *
 * The vocabulary is the set of label keys the gold set actually contains, so
 * the model is never asked for a class the benchmark cannot score.
 *
 * @throws when two label keys collapse onto the same taxonomy name — the
 *   mapping back to the label key would be ambiguous.
 */
export function buildTaxonomy(manifest: SplitManifest): Taxonomy {
  const labelKeys = [...new Set(manifest.assignments.map(labelKeyOf))].sort();
  const categories: TaxonomyCategory[] = [];
  const labelKeyByName = new Map<string, string>();

  for (const labelKey of labelKeys) {
    const name = taxonomyNameOf(labelKey);
    if (name.length === 0) {
      throw new Error(
        `the gold label key '${labelKey}' has no usable taxonomy name — the taxonomy ` +
          'cannot be built.',
      );
    }
    const existing = labelKeyByName.get(name);
    if (existing !== undefined) {
      throw new Error(
        `the gold vocabulary maps two label keys onto the taxonomy name '${name}': ` +
          `'${existing}' and '${labelKey}'. The taxonomy would be ambiguous — rename one of ` +
          'the object classes.',
      );
    }
    labelKeyByName.set(name, labelKey);
    categories.push({ name, description: describeLabelKey(labelKey) });
  }

  return { document: { description: TAXONOMY_DESCRIPTION, categories }, labelKeyByName };
}
