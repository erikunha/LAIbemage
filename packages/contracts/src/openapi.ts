import { z } from 'zod';
import {
  ActorSchema,
  AgentActorSchema,
  AnnotationActorSchema,
  EntityIdSchema,
  HumanActorSchema,
  JsonValueSchema,
  ModelActorSchema,
  PredictionActorSchema,
  RegionSchema,
  Sha256Schema,
  TimestampSchema,
} from './base.js';
import { ENTITY_SCHEMAS } from './entities/index.js';
import { ENUM_SCHEMAS } from './enums.js';
import { CONTRACTS_VERSION } from './version.js';

/**
 * OpenAPI 3.1 seed generated from the live contract schemas (spec 002 task
 * 1.5 / 6.1, FR-007, US5).
 *
 * The generator is a PURE function over the schemas: no filesystem, no clock,
 * no network. The same schemas always produce the same document, which is
 * what makes the committed snapshot a meaningful drift detector.
 *
 * The OpenAPI document is GENERATED, never hand-written (constitution III).
 * Everything below — the entity components, the enum components, the CRUD
 * skeleton — is derived from `ENTITY_SCHEMAS` and `ENUM_SCHEMAS`; there is no
 * second, hand-maintained copy of the wire shape anywhere.
 */

/** The OpenAPI version this document targets. */
export const OPENAPI_VERSION = '3.1.0';

/**
 * The JSON Schema dialect every schema of the document is written in.
 *
 * OpenAPI 3.1 is JSON Schema 2020-12 based, so the dialect is stated
 * explicitly instead of being left implicit.
 */
export const OPENAPI_JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** A JSON Schema node, as produced by zod's `toJSONSchema`. */
export interface JsonSchemaNode {
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
  type?: string;
  format?: string;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode;
  additionalProperties?: boolean | JsonSchemaNode;
  title?: string;
  description?: string;
  discriminator?: DiscriminatorObject;
  [keyword: string]: unknown;
}

/** The OpenAPI `discriminator` object. */
export interface DiscriminatorObject {
  propertyName: string;
  mapping?: Record<string, string>;
}

/** An OpenAPI 3.1 document, as a plain JSON value. */
export interface OpenApiDocument {
  openapi: string;
  jsonSchemaDialect: string;
  info: {
    title: string;
    version: string;
    description: string;
  };
  paths: Record<string, OpenApiPathItem>;
  components: {
    schemas: Record<string, JsonSchemaNode>;
  };
  tags: { name: string; description: string }[];
}

/** An OpenAPI path item: the operations available on one path. */
export interface OpenApiPathItem {
  get?: OpenApiOperation;
  post?: OpenApiOperation;
  put?: OpenApiOperation;
  delete?: OpenApiOperation;
}

/** An OpenAPI operation. */
export interface OpenApiOperation {
  operationId: string;
  summary: string;
  description: string;
  tags: string[];
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses: Record<string, OpenApiResponse>;
}

/** An OpenAPI parameter. */
export interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  description: string;
  schema: JsonSchemaNode;
}

/** An OpenAPI request body. */
export interface OpenApiRequestBody {
  required: boolean;
  description: string;
  content: Record<string, { schema: JsonSchemaNode }>;
}

/** An OpenAPI response. */
export interface OpenApiResponse {
  description: string;
  content?: Record<string, { schema: JsonSchemaNode }>;
}

/**
 * The shared schemas that are referenced by more than one entity, keyed by
 * the component name they get in `components.schemas`.
 *
 * They are registered in a zod metadata registry so that zod's JSON-Schema
 * conversion emits `$ref`s to them instead of inlining a copy at every use
 * site. Without this, `Region` would be duplicated into `Sample` and
 * `Annotation`, and a change to it would have to be applied in two places.
 */
const SHARED_SCHEMAS: Record<string, z.ZodType> = {
  EntityId: EntityIdSchema,
  Timestamp: TimestampSchema,
  Sha256: Sha256Schema,
  Region: RegionSchema,
  JsonValue: JsonValueSchema,
  HumanActor: HumanActorSchema,
  ModelActor: ModelActorSchema,
  AgentActor: AgentActorSchema,
  Actor: ActorSchema,
  AnnotationActor: AnnotationActorSchema,
  PredictionActor: PredictionActorSchema,
};

/**
 * The registry of schemas that carry a stable component name.
 *
 * The registry is created per call: it is a local zod registry, never the
 * global one, so generating a document cannot mutate state shared with the
 * rest of the package.
 */
function buildRegistry(): z.core.$ZodRegistry<Record<string, unknown>> {
  const registry = z.registry<Record<string, unknown>>();
  for (const [name, schema] of Object.entries(SHARED_SCHEMAS)) {
    registry.add(schema, { id: name });
  }
  for (const [name, schema] of Object.entries(ENUM_SCHEMAS)) {
    registry.add(schema, { id: name });
  }
  return registry;
}

/**
 * The safe-integer bounds zod emits for every `.int()`.
 *
 * They are an artifact of the integer FORMAT, not a constraint the contract
 * author wrote. The contract manifest already treats them as non-constraints
 * (`src/manifest.ts`); the OpenAPI seed drops them for the same reason, so
 * the two views of the contract agree on what counts as a constraint.
 */
const SAFE_INT_MAX = 9007199254740991;
const SAFE_INT_MIN = -9007199254740991;

/**
 * The order the keys of a schema are written in.
 *
 * zod's own key order is deterministic but arbitrary; fixing an order here
 * keeps the committed snapshot diff small and readable when a schema changes.
 */
const CANONICAL_KEY_ORDER = [
  '$ref',
  'title',
  'description',
  'type',
  'format',
  'const',
  'enum',
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
  'properties',
  'required',
  'additionalProperties',
  'propertyNames',
  'items',
  'default',
  'anyOf',
  'oneOf',
  'allOf',
  'discriminator',
] as const;

/** True for a plain JSON object (not an array, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A `$ref` pointing at a component of the generated document. */
function componentRef(name: string): JsonSchemaNode {
  return { $ref: `#/components/schemas/${name}` };
}

/**
 * Normalises a JSON Schema node: drops the zod-only keywords, drops the
 * safe-integer format artifacts and writes the keys in a fixed order.
 *
 * The transformation is pure and recursive, so a schema nested three levels
 * deep is normalised exactly like a top-level one.
 */
function normalize(node: JsonSchemaNode): JsonSchemaNode {
  if (Array.isArray(node)) {
    return node.map((item) => normalize(item as JsonSchemaNode)) as unknown as JsonSchemaNode;
  }
  if (!isPlainObject(node)) return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === '$defs') continue;
    if (key === 'maximum' && value === SAFE_INT_MAX) continue;
    if (key === 'minimum' && value === SAFE_INT_MIN) continue;

    if (key === 'properties' && isPlainObject(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, normalize(schema as JsonSchemaNode)]),
      );
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        isPlainObject(item) ? normalize(item as JsonSchemaNode) : item,
      );
      continue;
    }
    if (isPlainObject(value)) {
      result[key] = normalize(value as JsonSchemaNode);
      continue;
    }
    result[key] = value;
  }

  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_KEY_ORDER) {
    if (key in result) ordered[key] = result[key];
  }
  for (const key of Object.keys(result)) {
    if (!(key in ordered)) ordered[key] = result[key];
  }
  return ordered as JsonSchemaNode;
}

/**
 * Rewrites zod's `#/$defs/...` references to OpenAPI component references.
 *
 * zod emits references into the `$defs` bag of the schema it converted;
 * OpenAPI has no such bag, so every reference is repointed at
 * `components.schemas`.
 */
function rewriteRefs(node: JsonSchemaNode, resolve: (defName: string) => string): JsonSchemaNode {
  if (Array.isArray(node)) {
    return node.map((item) =>
      rewriteRefs(item as JsonSchemaNode, resolve),
    ) as unknown as JsonSchemaNode;
  }
  if (!isPlainObject(node)) return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$schema' || key === '$defs') continue;
    if (key === '$ref' && typeof value === 'string') {
      const match = /^#\/\$defs\/(.+)$/.exec(value);
      result.$ref = match ? `#/components/schemas/${resolve(match[1])}` : value;
      continue;
    }
    if (key === 'properties' && isPlainObject(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          rewriteRefs(schema as JsonSchemaNode, resolve),
        ]),
      );
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        isPlainObject(item) ? rewriteRefs(item as JsonSchemaNode, resolve) : item,
      );
      continue;
    }
    if (isPlainObject(value)) {
      result[key] = rewriteRefs(value as JsonSchemaNode, resolve);
      continue;
    }
    result[key] = value;
  }
  return result as JsonSchemaNode;
}

/** Resolves a component reference (`#/components/schemas/X`) to its schema. */
export type SchemaResolver = (ref: string) => JsonSchemaNode | undefined;

/**
 * The properties of a union branch.
 *
 * A branch is usually a `$ref` to a component (that is what the registry
 * produces), so the discriminating `const` lives in the referenced schema
 * rather than in the branch itself.
 */
function branchProperties(
  branch: JsonSchemaNode,
  resolve: SchemaResolver,
): Record<string, JsonSchemaNode> | undefined {
  if (branch.properties) return branch.properties;
  if (branch.$ref) return resolve(branch.$ref)?.properties;
  return undefined;
}

/**
 * Finds the discriminating property of a union's branches.
 *
 * A discriminated union (zod's `z.discriminatedUnion`) puts a `const` on one
 * property of every branch — `kind` for the actor variants. The property that
 * carries the `const` is the discriminator.
 *
 * The mapping is only produced when every branch is a `$ref`, because the
 * OpenAPI `discriminator.mapping` has to point at a schema.
 */
function findDiscriminator(
  branches: JsonSchemaNode[],
  resolve: SchemaResolver,
): { propertyName: string; mapping: Record<string, string> } | null {
  if (branches.length === 0) return null;

  const candidates = new Set<string>();
  for (const branch of branches) {
    const properties = branchProperties(branch, resolve);
    for (const key of Object.keys(properties ?? {})) {
      if (properties?.[key]?.const !== undefined) candidates.add(key);
    }
  }

  for (const propertyName of candidates) {
    const mapping: Record<string, string> = {};
    const values = new Set<string>();
    let complete = true;

    for (const branch of branches) {
      const properties = branchProperties(branch, resolve);
      const constant = properties?.[propertyName]?.const;
      if (constant === undefined) {
        complete = false;
        break;
      }
      const value = String(constant);
      // Two branches with the same constant are NOT exclusive, so the union
      // cannot be a `oneOf` and cannot carry a discriminator.
      if (values.has(value)) {
        complete = false;
        break;
      }
      values.add(value);
      if (branch.$ref) mapping[value] = branch.$ref;
    }

    if (complete) return { propertyName, mapping };
  }
  return null;
}

/**
 * Adds the OpenAPI `discriminator` object to every discriminated union in a
 * schema, and rewrites `anyOf` into `oneOf` where the union is exclusive.
 *
 * zod emits `oneOf` for `z.discriminatedUnion` but never the OpenAPI
 * `discriminator` keyword, so the mapping between the discriminator value and
 * the schema that accepts it has to be built here.
 *
 * The transformation is a small, pure function so it can be tested on its own.
 */
export function applyDiscriminators(node: JsonSchemaNode, resolve: SchemaResolver): JsonSchemaNode {
  if (Array.isArray(node)) {
    return node.map((item) =>
      applyDiscriminators(item as JsonSchemaNode, resolve),
    ) as unknown as JsonSchemaNode;
  }
  if (!isPlainObject(node)) return node;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isPlainObject(value)) {
      result[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          applyDiscriminators(schema as JsonSchemaNode, resolve),
        ]),
      );
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        isPlainObject(item) ? applyDiscriminators(item as JsonSchemaNode, resolve) : item,
      );
      continue;
    }
    if (isPlainObject(value)) {
      result[key] = applyDiscriminators(value as JsonSchemaNode, resolve);
      continue;
    }
    result[key] = value;
  }

  const union = result.oneOf ?? result.anyOf;
  if (Array.isArray(union) && union.length > 0) {
    const discriminator = findDiscriminator(union as JsonSchemaNode[], resolve);
    if (discriminator) {
      result.oneOf = union;
      delete result.anyOf;
      result.discriminator = {
        propertyName: discriminator.propertyName,
        ...(Object.keys(discriminator.mapping).length > 0
          ? { mapping: discriminator.mapping }
          : {}),
      };
    }
  }

  return result as JsonSchemaNode;
}

/** The result of converting one schema with zod's JSON-Schema conversion. */
interface Conversion {
  /** The converted schema, without its `$defs` bag. */
  root: JsonSchemaNode;
  /** The definitions the converted schema references. */
  defs: Record<string, JsonSchemaNode>;
}

/**
 * Converts one schema to JSON Schema.
 *
 * `io: 'input'` is used on purpose: the same direction the contract
 * manifest uses, so the `required` arrays describe what a producer must send.
 *
 * `reused: 'inline'` keeps zod from extracting anonymous definitions that
 * would have no stable name in `components.schemas`; only the schemas
 * registered in the metadata registry become components.
 */
function convert(
  schema: z.ZodType,
  registry: z.core.$ZodRegistry<Record<string, unknown>>,
): Conversion {
  const converted = z.toJSONSchema(schema, {
    io: 'input',
    metadata: registry,
    reused: 'inline',
    // zod drops the description of a RECURSIVE schema, because the schema is
    // extracted into a definition and the description would have nowhere to
    // live. The override hook puts it back, reading it from the schema
    // itself so the prose stays in ONE place — the schema.
    override: (ctx) => {
      if (ctx.jsonSchema.description !== undefined) return;
      const description = (ctx.zodSchema as { description?: string }).description;
      if (description === undefined) return;
      ctx.jsonSchema.description = description;
    },
  }) as JsonSchemaNode;

  const root: JsonSchemaNode = { ...converted };
  delete root.$defs;
  delete root.$schema;

  return { root, defs: converted.$defs ?? {} };
}

/**
 * The component of a schema, and the definition names it refers to itself.
 *
 * zod converts a RECURSIVE schema into a `$ref` to an anonymous definition,
 * because the body has to be extracted for the self-reference to point at.
 * In that case the definition — not the reference — is the component, and
 * the self-reference has to be repointed at it.
 */
function componentOf(
  name: string,
  conversion: Conversion,
): { component: JsonSchemaNode; selfDefs: string[] } {
  const match = conversion.root.$ref ? /^#\/\$defs\/(.+)$/.exec(conversion.root.$ref) : null;
  if (match) {
    const definition = conversion.defs[match[1]];
    if (definition) return { component: definition, selfDefs: [match[1]] };
  }
  void name;
  return { component: conversion.root, selfDefs: [] };
}

/**
 * The definition names a schema body refers to.
 */
function collectDefRefs(node: JsonSchemaNode, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDefRefs(item as JsonSchemaNode, into);
    return;
  }
  if (!isPlainObject(node)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') {
      const match = /^#\/\$defs\/(.+)$/.exec(value);
      if (match) into.add(match[1]);
      continue;
    }
    if (isPlainObject(value)) collectDefRefs(value as JsonSchemaNode, into);
    else if (Array.isArray(value)) {
      for (const item of value) collectDefRefs(item as JsonSchemaNode, into);
    }
  }
}

/**
 * Puts the description of a schema back when zod dropped it.
 *
 * zod keeps the description of an ordinary schema, but a RECURSIVE one is
 * extracted into a definition and the description is lost with the root. The
 * prose is read back from the schema itself, so it still lives in exactly one
 * place — next to the schema it describes.
 */
function withDescription(component: JsonSchemaNode, schema: z.ZodType): JsonSchemaNode {
  const description = (schema as { description?: string }).description;
  if (description === undefined || component.description !== undefined) return component;
  return { description, ...component };
}

/** Turns a definition name into a component name fragment. */
function componentFragment(defName: string): string {
  return defName
    .replace(/^_+/, '')
    .replace(
      /(^|[^a-zA-Z0-9])([a-zA-Z0-9])/g,
      (_match, prefix: string, letter: string) => `${prefix}${letter.toUpperCase()}`,
    );
}

/**
 * The plural, kebab-case resource path of an entity: `Asset` → `/assets`,
 * `DatasetSnapshot` → `/dataset-snapshots`.
 */
function resourcePath(entityName: string): string {
  const kebab = entityName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return `/${kebab}s`;
}

/** The singular resource name of an entity: `Asset` → `asset`. */
function resourceName(entityName: string): string {
  return entityName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * The CRUD skeleton of one entity.
 *
 * The skeleton is deliberately minimal and honest: it declares that the
 * entities are addressable and what their request and response bodies are,
 * and nothing else. The behaviour behind these operations belongs to the API
 * service (spec 009), which is why every operation says so and why the
 * operation ids are prefixed `spec002Skeleton`.
 *
 * Each entity contributes two path templates — the collection and the item —
 * which together carry the five operations of the CRUD skeleton.
 */
function crudSkeleton(
  entityName: string,
  schemaComponent: string,
): Record<string, OpenApiPathItem> {
  const path = resourcePath(entityName);
  const name = resourceName(entityName);
  const ref = componentRef(schemaComponent);
  const idParam: OpenApiParameter = {
    name: 'id',
    in: 'path',
    required: true,
    description: `Identifier of the ${name}.`,
    schema: componentRef('EntityId'),
  };
  const collection: OpenApiPathItem = {
    get: {
      operationId: `spec002SkeletonList${entityName}s`,
      summary: `List ${name}s`,
      description:
        'SKELETON — the list operation of the entity CRUD surface. ' +
        'The HTTP API service is spec 009; this document only declares the shape.',
      tags: [entityName],
      parameters: [
        {
          name: 'limit',
          in: 'query',
          required: false,
          description: 'Maximum number of items to return.',
          schema: { type: 'integer', minimum: 1 },
        },
      ],
      responses: {
        '200': {
          description: `The list of ${name}s.`,
          content: { 'application/json': { schema: { type: 'array', items: ref } } },
        },
        default: {
          description: 'Error response — the error contract is defined by spec 009.',
        },
      },
    },
    post: {
      operationId: `spec002SkeletonCreate${entityName}`,
      summary: `Create a ${name}`,
      description:
        'SKELETON — the create operation of the entity CRUD surface. ' +
        'The HTTP API service is spec 009; this document only declares the shape.',
      tags: [entityName],
      requestBody: {
        required: true,
        description: `The ${name} to create.`,
        content: { 'application/json': { schema: ref } },
      },
      responses: {
        '201': {
          description: `The created ${name}.`,
          content: { 'application/json': { schema: ref } },
        },
        default: {
          description: 'Error response — the error contract is defined by spec 009.',
        },
      },
    },
  };

  const item: OpenApiPathItem = {
    get: {
      operationId: `spec002SkeletonGet${entityName}`,
      summary: `Get a ${name}`,
      description:
        'SKELETON — the read operation of the entity CRUD surface. ' +
        'The HTTP API service is spec 009; this document only declares the shape.',
      tags: [entityName],
      parameters: [idParam],
      responses: {
        '200': {
          description: `The ${name}.`,
          content: { 'application/json': { schema: ref } },
        },
        default: {
          description: 'Error response — the error contract is defined by spec 009.',
        },
      },
    },
    put: {
      operationId: `spec002SkeletonUpdate${entityName}`,
      summary: `Update a ${name}`,
      description:
        'SKELETON — the replace operation of the entity CRUD surface. ' +
        'The HTTP API service is spec 009; this document only declares the shape.',
      tags: [entityName],
      parameters: [idParam],
      requestBody: {
        required: true,
        description: `The new content of the ${name}.`,
        content: { 'application/json': { schema: ref } },
      },
      responses: {
        '200': {
          description: `The updated ${name}.`,
          content: { 'application/json': { schema: ref } },
        },
        default: {
          description: 'Error response — the error contract is defined by spec 009.',
        },
      },
    },
    delete: {
      operationId: `spec002SkeletonDelete${entityName}`,
      summary: `Delete a ${name}`,
      description:
        'SKELETON — the delete operation of the entity CRUD surface. ' +
        'The HTTP API service is spec 009; this document only declares the shape.',
      tags: [entityName],
      parameters: [idParam],
      responses: {
        '204': { description: `The ${name} was deleted.` },
        default: {
          description: 'Error response — the error contract is defined by spec 009.',
        },
      },
    },
  };

  return { [path]: collection, [`${path}/{id}`]: item };
}

/**
 * Generates the OpenAPI 3.1 document from the live contract schemas.
 *
 * The result is deterministic: the same schemas always yield the same
 * document, so the committed snapshot is a meaningful drift detector.
 */
export function buildOpenApiDocument(): OpenApiDocument {
  const registry = buildRegistry();
  const schemas: Record<string, JsonSchemaNode> = {};
  const paths: Record<string, OpenApiPathItem> = {};
  const tags: { name: string; description: string }[] = [];

  // The names that already are components: every shared schema, every enum
  // and every entity. A reference to one of them is repointed at the
  // component instead of being inlined.
  const componentNames = new Set<string>([
    ...Object.keys(SHARED_SCHEMAS),
    ...Object.keys(ENUM_SCHEMAS),
    ...Object.keys(ENTITY_SCHEMAS),
  ]);

  // The definition names that belong to a component, and the component they
  // belong to.
  //
  // zod emits a registered schema as an ALIAS: the definition named after the
  // registration id points at the definition that holds the body. The body
  // belongs to the component, so a reference to it is repointed there instead
  // of being hoisted into a second, private copy.
  const ownedDefs = new Map<string, string>();

  // Shared building blocks first, so an entity that references one emits a
  // `$ref` to the shared component rather than an inline copy.
  for (const [name, schema] of Object.entries(SHARED_SCHEMAS)) {
    const conversion = convert(schema, registry);
    const { component, selfDefs } = componentOf(name, conversion);
    for (const defName of selfDefs) ownedDefs.set(defName, name);
    for (const [defName, definition] of Object.entries(conversion.defs)) {
      const alias = definition.$ref ? /^#\/\$defs\/(.+)$/.exec(definition.$ref) : null;
      if (alias && Object.keys(definition).length === 1) ownedDefs.set(alias[1], name);
      void defName;
    }

    const local = new Map<string, string>(selfDefs.map((defName) => [defName, name]));
    schemas[name] = rewriteRefs(withDescription(component, schema), (defName) => {
      const localName = local.get(defName);
      if (localName) return localName;
      if (!componentNames.has(defName)) {
        throw new Error(
          `Shared schema "${name}" references the unknown definition "${defName}". ` +
            'Register the schema in SHARED_SCHEMAS so it becomes a component.',
        );
      }
      return defName;
    });
  }

  for (const [name, schema] of Object.entries(ENUM_SCHEMAS)) {
    const conversion = convert(schema, registry);
    schemas[name] = withDescription(componentOf(name, conversion).component, schema);
  }

  for (const [name, schema] of Object.entries(ENTITY_SCHEMAS)) {
    const conversion = convert(schema, registry);
    const { component } = componentOf(name, conversion);

    // A definition zod could not name is hoisted into a component of its
    // own, named after the entity that owns it, so the reference resolves.
    const referenced = new Set<string>();
    collectDefRefs(component, referenced);
    for (const defName of Object.keys(conversion.defs)) {
      const definition = conversion.defs[defName];
      const alias = definition.$ref ? /^#\/\$defs\/(.+)$/.exec(definition.$ref) : null;
      if (alias && Object.keys(definition).length === 1) ownedDefs.set(alias[1], name);
    }

    const hoisted = new Map<string, string>();
    const pending = [...referenced];
    while (pending.length > 0) {
      const defName = pending.pop() as string;
      if (componentNames.has(defName) || ownedDefs.has(defName) || hoisted.has(defName)) continue;
      hoisted.set(defName, `${name}${componentFragment(defName)}`);
      const definition = conversion.defs[defName];
      if (!definition) continue;
      const nested = new Set<string>();
      collectDefRefs(definition, nested);
      for (const nestedName of nested) pending.push(nestedName);
    }

    const resolveDefinition = (defName: string): string => {
      if (componentNames.has(defName)) return defName;
      const owner = ownedDefs.get(defName);
      if (owner) return owner;
      const hoistedName = hoisted.get(defName);
      if (hoistedName) return hoistedName;
      throw new Error(
        `Entity "${name}" references the unknown definition "${defName}". ` +
          'Register the schema so it becomes a component of the document.',
      );
    };

    schemas[name] = rewriteRefs(withDescription(component, schema), resolveDefinition);
    for (const [defName, componentName] of hoisted) {
      schemas[componentName] = rewriteRefs(conversion.defs[defName], resolveDefinition);
    }

    Object.assign(paths, crudSkeleton(name, name));
    tags.push({
      name,
      description: `${name} — an entity of the Master Vision domain model.`,
    });
  }

  // The discriminator keywords are added last, so every `$ref` they map to
  // already exists.
  const resolveComponent: SchemaResolver = (ref) => {
    const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
    return match ? schemas[match[1]] : undefined;
  };
  for (const [name, schema] of Object.entries(schemas)) {
    schemas[name] = applyDiscriminators(schema, resolveComponent);
  }

  for (const [name, schema] of Object.entries(schemas)) {
    schemas[name] = { title: name, ...normalize(schema) };
  }

  return {
    openapi: OPENAPI_VERSION,
    jsonSchemaDialect: OPENAPI_JSON_SCHEMA_DIALECT,
    info: {
      title: 'Master Vision',
      version: CONTRACTS_VERSION,
      description:
        'Master Vision — Visual Intelligence Engineering Workbench. ' +
        'Generated from @master-vision/contracts, the single source of truth for ' +
        'the domain model and the operations of the platform (constitution III, ' +
        'contracts-first). The entity schemas are served unchanged by the API ' +
        'service of spec 009.',
    },
    paths,
    components: { schemas },
    tags,
  };
}

/**
 * Serializes a document the way the snapshot and the build artifact are
 * written, so the two are byte-identical.
 */
export function serializeOpenApiDocument(document: OpenApiDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * The generated OpenAPI document.
 *
 * Exported so a consumer (spec 009) can `import { openapiDocument } from
 * '@master-vision/contracts/openapi'` without reading the file.
 */
export const openapiDocument: OpenApiDocument = buildOpenApiDocument();
