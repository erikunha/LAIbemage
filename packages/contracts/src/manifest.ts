import { z } from 'zod';
import { ENTITY_SCHEMAS } from './entities/index.js';
import { ENUM_SCHEMAS } from './enums.js';
import { CONTRACTS_VERSION } from './version.js';

/**
 * Contract manifest: a machine-readable digest of the public shape of the
 * contract package (spec 002 task 1.4).
 *
 * It is derived from the LIVE schemas through zod's JSON-Schema conversion, so
 * it cannot drift from the code without the staleness check in
 * `tests/version-guard.test.ts` failing.
 *
 * Every field is described by TWO independent strings:
 *
 *  - `type` — the SHAPE of the value (`uuid`, `string`, `enum("a"|"b")`,
 *    `object{x,y}`, `array<string>`, `json`, …). It says what the value IS.
 *  - `constraint` — the VALIDATION the value must satisfy (`pattern=…`,
 *    `minLength=1`, `minimum=0`, …). It says what the value MUST LOOK LIKE.
 *
 * The split matters: the two change for different reasons and must be
 * classified differently by the breaking-change guard. A widened range is a
 * relaxation, a narrowed one is a tightening, and a changed pattern (e.g. the
 * sha256 digest format) breaks every consumer that validated the old one.
 */

/** One field of one entity. */
export interface ManifestField {
  /** Whether the field must be present in the INPUT payload. */
  required: boolean;
  /** Canonical signature of the field's SHAPE (e.g. `uuid`, `enum("a"|"b")`). */
  type: string;
  /**
   * Canonical signature of the field's VALIDATION CONSTRAINT
   * (e.g. `pattern=^[0-9a-f]{64}$`).
   *
   * Absent when the field carries no constraint beyond its type.
   */
  constraint?: string;
}

/** One entity: its fields, keyed by field name. */
export interface ManifestEntity {
  fields: Record<string, ManifestField>;
}

/** The whole contract surface, as committed to `contract-manifest.json`. */
export interface ContractManifest {
  contractsVersion: string;
  entities: Record<string, ManifestEntity>;
  enums: Record<string, string[]>;
}

/** The subset of JSON Schema this module reads. */
export interface JsonSchemaNode {
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
  type?: string;
  format?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  additionalProperties?: boolean | JsonSchemaNode;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  multipleOf?: number;
  pattern?: string;
}

/**
 * The JSON-Schema keywords that constrain a value, in the canonical order the
 * constraint signature lists them.
 */
const CONSTRAINT_KEYWORDS = [
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minItems',
  'maxItems',
  'multipleOf',
] as const;

/**
 * The safe-integer bounds zod emits for every `.int()`.
 *
 * They are an artifact of the integer FORMAT, not a constraint the contract
 * author wrote, so they are not recorded as one — otherwise every integer
 * field would carry a meaningless constraint.
 */
const SAFE_INT_MIN = -9007199254740991;
const SAFE_INT_MAX = 9007199254740991;

/**
 * True for the recursive schema zod emits for `z.json()`: a union of the
 * JSON primitives plus an array and an object that both point back at it.
 *
 * Detected BEFORE recursion, otherwise the self-referencing `$ref` would
 * recurse forever.
 */
export function isJsonValueNode(node: JsonSchemaNode): boolean {
  const members = node.anyOf;
  if (!members || members.length < 5) return false;
  return (
    members.some((m) => m.type === 'null') &&
    members.some((m) => m.type === 'array') &&
    members.some((m) => m.type === 'object')
  );
}

/**
 * Resolves a `$ref` node to the definition it points at.
 *
 * A node that is not a `$ref` resolves to itself.
 */
function resolveNode(node: JsonSchemaNode, defs: Record<string, JsonSchemaNode>): JsonSchemaNode {
  if (!node.$ref) return node;
  const key = node.$ref.replace('#/$defs/', '');
  return defs[key] ?? node;
}

/**
 * Canonical signature of a JSON Schema node's SHAPE.
 *
 * Deliberately lossy about details that do not change the wire contract
 * (e.g. the exact regex of a date-time format) and precise about everything
 * that does (nested field names of strict objects, enum members, array item
 * types). The validation CONSTRAINT of a node is captured separately by
 * {@link constraintSignature}.
 */
export function typeSignature(node: JsonSchemaNode, defs: Record<string, JsonSchemaNode>): string {
  const target = resolveNode(node, defs);
  if (isJsonValueNode(target)) return 'json';
  if ('const' in target) return `literal(${JSON.stringify(target.const)})`;
  if (target.enum) return `enum(${target.enum.map((v) => JSON.stringify(v)).join('|')})`;
  if (target.anyOf) {
    return `union(${target.anyOf.map((m) => typeSignature(m, defs)).join('|')})`;
  }
  if (target.oneOf) return `union(${target.oneOf.map((m) => typeSignature(m, defs)).join('|')})`;
  if (target.type === 'array') return `array<${typeSignature(target.items ?? {}, defs)}>`;
  if (target.type === 'object') {
    if (target.properties) {
      const keys = Object.keys(target.properties)
        .sort()
        .map((key) => {
          // A property pinned to a single literal (the `kind` of an actor
          // variant) is part of the shape: changing the literal changes what
          // the field accepts, so it must be visible in the signature.
          const constValue = target.properties?.[key]?.const;
          return constValue === undefined ? key : `${key}=${JSON.stringify(constValue)}`;
        });
      return `object{${keys.join(',')}}`;
    }
    if (target.additionalProperties && typeof target.additionalProperties === 'object') {
      return `map<string,${typeSignature(target.additionalProperties, defs)}>`;
    }
    return 'object';
  }
  if (target.type === 'string') return target.format ?? 'string';
  if (target.type) return target.type;
  return 'unknown';
}

/**
 * Canonical signature of a JSON Schema node's VALIDATION CONSTRAINT.
 *
 * Returns a `;`-separated list of `keyword=value` pairs, e.g.
 * `pattern=^[0-9a-f]{64}$` or `minimum=0;maximum=1`.
 *
 * An empty string means "no constraint beyond the type" — the field accepts
 * every value its type allows. Tightening any of these keywords narrows what
 * a consumer may send, which the breaking-change guard treats as breaking.
 */
export function constraintSignature(
  node: JsonSchemaNode,
  defs: Record<string, JsonSchemaNode>,
): string {
  const target = resolveNode(node, defs);
  if (isJsonValueNode(target)) return '';

  const parts: string[] = [];
  for (const keyword of CONSTRAINT_KEYWORDS) {
    const value = target[keyword];
    if (value === undefined) continue;
    // The safe-integer bounds are a format artifact, not a written constraint.
    if (keyword === 'minimum' && value === SAFE_INT_MIN) continue;
    if (keyword === 'maximum' && value === SAFE_INT_MAX) continue;
    parts.push(`${keyword}=${String(value)}`);
  }
  return parts.join(';');
}

/** Derives the manifest entry of one entity from its live schema. */
function manifestEntity(schema: z.ZodType): ManifestEntity {
  const json = z.toJSONSchema(schema, { io: 'input' }) as JsonSchemaNode;
  const defs = json.$defs ?? {};
  const required = new Set(json.required ?? []);
  const fields: Record<string, ManifestField> = {};
  for (const [name, node] of Object.entries(json.properties ?? {})) {
    const constraint = constraintSignature(node, defs);
    fields[name] = {
      required: required.has(name),
      type: typeSignature(node, defs),
      ...(constraint ? { constraint } : {}),
    };
  }
  return { fields };
}

/**
 * Builds the contract manifest from the live schemas.
 *
 * `io: 'input'` is used on purpose: a field with a `.default()` is optional in
 * the input and always present in the output, and "must the producer send it"
 * is the question the breaking-change guard asks.
 */
export function buildContractManifest(): ContractManifest {
  const entities: Record<string, ManifestEntity> = {};
  for (const [name, schema] of Object.entries(ENTITY_SCHEMAS)) {
    entities[name] = manifestEntity(schema);
  }
  const enums: Record<string, string[]> = {};
  for (const [name, schema] of Object.entries(ENUM_SCHEMAS)) {
    enums[name] = [...schema.options].sort();
  }
  return { contractsVersion: CONTRACTS_VERSION, entities, enums };
}
