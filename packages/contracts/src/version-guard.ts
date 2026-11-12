import type { ContractManifest, ManifestEntity } from './manifest.js';

/**
 * Breaking-change guard for the contract package (spec 002 task 1.4, FR-001).
 *
 * Every function here is PURE: it takes two manifests and returns a verdict.
 * No git, no filesystem, no clock — which is what makes the guard unit-testable
 * on its own and reusable by any consumer that wants to diff two contract
 * revisions.
 */

/** The classes of change the guard treats as breaking. */
export type BreakingChangeKind =
  | 'entity-removed'
  | 'field-removed'
  | 'field-type-changed'
  | 'field-constraint-changed'
  | 'field-became-required'
  | 'enum-value-removed';

/** One breaking difference between two manifests. */
export interface BreakingChange {
  kind: BreakingChangeKind;
  /** Dotted path of what changed, e.g. `Asset.sha256` or `JobState`. */
  path: string;
  /** Human-readable explanation. */
  detail: string;
}

/** The result of diffing two manifests. */
export interface ManifestDiff {
  /** Differences that require a MAJOR version bump. */
  breaking: BreakingChange[];
  /** Differences that are safe (additions and relaxations). */
  additive: string[];
}

/** The verdict of the version-bump check. */
export interface VersionBumpCheck {
  /** True when the version satisfies the diff. */
  ok: boolean;
  /** True when the diff contains at least one breaking change. */
  requiredMajorBump: boolean;
  /** The breaking differences found. */
  breaking: BreakingChange[];
  /** Explanation, suitable for a CI log line. */
  reason: string;
}

/** Extracts the MAJOR component of a semver string. */
export function majorVersion(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) throw new Error(`Not a semver version: "${version}"`);
  return Number(match[1]);
}

/**
 * Parses an `enum("a"|"b")` manifest type string into its value set, or
 * null when the type is not an enum.
 */
function enumValuesOf(type: string): string[] | null {
  const match = /^enum\("(.*)"\)$/.exec(type);
  if (!match) return null;
  return match[1]!.split('"|"');
}

/**
 * True when `baseType` and `currentType` are BOTH enum type strings and the
 * current value set contains every base value: a WIDENING.
 *
 * The guard's own rule (below, and the docblock of {@link diffManifests})
 * calls a new enum value compatible: a payload that used to validate still
 * does. That rule must hold for an enum carried inside a field type exactly
 * as it holds for the named enums, so a widened field enum is additive, not
 * a type change. A NARROWING (a value gone) is not a widening: it stays
 * breaking.
 */
function isWideningEnumType(baseType: string, currentType: string): boolean {
  const baseValues = enumValuesOf(baseType);
  const currentValues = enumValuesOf(currentType);
  if (!baseValues || !currentValues) return false;
  return baseValues.every((value) => currentValues.includes(value));
}

/**
 * Diffs one named-object surface (entities, worker frames) of two manifests.
 *
 * The same field-level rules apply to every surface, so the loop is written
 * once and parametrized by the noun used in the human-readable details.
 */
function diffObjectSurfaces(
  baseObjects: Record<string, ManifestEntity>,
  currentObjects: Record<string, ManifestEntity>,
  noun: 'Entity' | 'Frame',
  breaking: BreakingChange[],
  additive: string[],
): void {
  for (const [objectName, baseObject] of Object.entries(baseObjects)) {
    const currentObject = currentObjects[objectName];
    if (!currentObject) {
      breaking.push({
        kind: 'entity-removed',
        path: objectName,
        detail: `${noun} "${objectName}" no longer exists in the contract surface.`,
      });
      continue;
    }
    for (const [fieldName, baseField] of Object.entries(baseObject.fields)) {
      const currentField = currentObject.fields[fieldName];
      const path = `${objectName}.${fieldName}`;
      if (!currentField) {
        breaking.push({
          kind: 'field-removed',
          path,
          detail: `Field "${path}" was removed (was ${baseField.type}).`,
        });
        continue;
      }
      if (baseField.type !== currentField.type) {
        if (isWideningEnumType(baseField.type, currentField.type)) {
          // A widened field enum accepts every payload the base accepted.
          additive.push(`${path} widened its value set`);
        } else {
          breaking.push({
            kind: 'field-type-changed',
            path,
            detail: `Field "${path}" changed type: ${baseField.type} → ${currentField.type}.`,
          });
        }
      }
      const baseConstraint = baseField.constraint ?? '';
      const currentConstraint = currentField.constraint ?? '';
      if (baseConstraint !== currentConstraint) {
        breaking.push({
          kind: 'field-constraint-changed',
          path,
          detail:
            `Field "${path}" changed its validation constraint: ` +
            `${baseConstraint || '(none)'} → ${currentConstraint || '(none)'}.`,
        });
      }
      if (!baseField.required && currentField.required) {
        breaking.push({
          kind: 'field-became-required',
          path,
          detail: `Field "${path}" became required; a consumer's existing payload no longer validates.`,
        });
      }
      // required → optional is a RELAXATION, not a break: every payload that
      // validated before still validates. It is reported as additive.
      if (baseField.required && !currentField.required) {
        additive.push(`${path} became optional`);
      }
    }
    for (const [fieldName, currentField] of Object.entries(currentObject.fields)) {
      if (baseObject.fields[fieldName]) continue;
      if (currentField.required) {
        // A newly added REQUIRED field is a tightening: a consumer's existing
        // payload stops validating because the field is now mandatory.
        breaking.push({
          kind: 'field-became-required',
          path: `${objectName}.${fieldName}`,
          detail:
            `Field "${objectName}.${fieldName}" was added as REQUIRED; ` +
            "a consumer's existing payload no longer validates.",
        });
      } else {
        additive.push(`${objectName}.${fieldName}`);
      }
    }
  }

  for (const objectName of Object.keys(currentObjects)) {
    if (!baseObjects[objectName]) additive.push(objectName);
  }
}

/**
 * Diffs two contract manifests and classifies every difference.
 *
 * The direction of the rules is what matters here, and it is easy to get
 * backwards. A change is BREAKING when it NARROWS what a consumer may send
 * or RELIES on more than before; it is COMPATIBLE when it WIDENS what a
 * consumer may send or adds something optional.
 *
 * BREAKING (per FR-001 and the additive-only rule of the spec plan):
 *  - an entity was removed;
 *  - a field was removed;
 *  - a field changed its type/shape;
 *  - a field's validation constraint changed (e.g. the sha256 pattern was
 *    tightened — a payload that used to validate no longer does);
 *  - a field became REQUIRED, including a newly added required field: a
 *    consumer's existing payload stops validating;
 *  - an enum value was removed.
 *
 * COMPATIBLE (additive or a relaxation):
 *  - a new entity appeared;
 *  - a new OPTIONAL field appeared: existing payloads stay valid;
 *  - a field became optional: it is a relaxation, the payload that used to
 *    validate still validates;
 *  - a new enum value appeared: a payload that used to validate still does.
 */
export function diffManifests(base: ContractManifest, current: ContractManifest): ManifestDiff {
  const breaking: BreakingChange[] = [];
  const additive: string[] = [];

  diffObjectSurfaces(base.entities, current.entities, 'Entity', breaking, additive);
  diffObjectSurfaces(base.frames ?? {}, current.frames ?? {}, 'Frame', breaking, additive);

  for (const [enumName, baseValues] of Object.entries(base.enums)) {
    const currentValues = current.enums[enumName];
    if (!currentValues) {
      breaking.push({
        kind: 'enum-value-removed',
        path: enumName,
        detail: `Enum "${enumName}" no longer exists; its values ${baseValues.join(', ')} are gone.`,
      });
      continue;
    }
    for (const value of baseValues) {
      if (!currentValues.includes(value)) {
        breaking.push({
          kind: 'enum-value-removed',
          path: `${enumName}.${value}`,
          detail: `Enum value "${value}" was removed from "${enumName}".`,
        });
      }
    }
    for (const value of currentValues) {
      if (!baseValues.includes(value)) additive.push(`${enumName}.${value}`);
    }
  }

  for (const enumName of Object.keys(current.enums)) {
    if (!base.enums[enumName]) additive.push(enumName);
  }

  return { breaking, additive };
}

/**
 * Decides whether the current contracts version satisfies the diff.
 *
 * A breaking difference REQUIRES a MAJOR bump (the current major must be
 * strictly greater than the base major). Without breaking differences the
 * version may stay as it is, but it may never go DOWN.
 */
export function checkVersionBump(
  base: ContractManifest,
  current: ContractManifest,
): VersionBumpCheck {
  const { breaking } = diffManifests(base, current);
  const baseMajor = majorVersion(base.contractsVersion);
  const currentMajor = majorVersion(current.contractsVersion);

  if (breaking.length > 0) {
    const ok = currentMajor > baseMajor;
    return {
      ok,
      requiredMajorBump: true,
      breaking,
      reason: ok
        ? `Major bump ${base.contractsVersion} → ${current.contractsVersion} covers ${breaking.length} breaking change(s).`
        : `Breaking change(s) require a MAJOR bump of CONTRACTS_VERSION: ${base.contractsVersion} → ${current.contractsVersion} is not one (${breaking.map((b) => b.path).join(', ')}).`,
    };
  }

  const ok = currentMajor >= baseMajor;
  return {
    ok,
    requiredMajorBump: false,
    breaking: [],
    reason: ok
      ? `No breaking change between ${base.contractsVersion} and ${current.contractsVersion}.`
      : `CONTRACTS_VERSION went down: ${base.contractsVersion} → ${current.contractsVersion}.`,
  };
}
