import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ENTITY_SCHEMAS } from '../src/entities/index.js';
import { ENUM_SCHEMAS } from '../src/enums.js';
import {
  OPENAPI_JSON_SCHEMA_DIALECT,
  OPENAPI_VERSION,
  applyDiscriminators,
  buildOpenApiDocument,
  openapiDocument,
  serializeOpenApiDocument,
  type JsonSchemaNode,
  type OpenApiDocument,
} from '../src/openapi.js';
import { CONTRACTS_VERSION } from '../src/version.js';
import {
  createComponentValidators,
  createOpenApi31EnvelopeValidator,
  formatErrors,
} from './openapi-validator.js';

/**
 * The OpenAPI 3.1 seed (spec 002 task 1.5 / 6.1, FR-007, US5).
 *
 * The seed is GENERATED from the live schemas, so these tests are not
 * "assert the document looks like this" — they assert the PROPERTIES that
 * make the document usable by the API service of spec 009:
 *
 *  - it is a real OpenAPI 3.1 document (checked against the official schema);
 *  - every entity and every enum of the domain model is a component;
 *  - the discriminated unions carry a discriminator, so a consumer can pick
 *    the branch without guessing;
 *  - a JSON-shaped field is a real JSON Schema, not an opaque string;
 *  - no reference points at a component that does not exist;
 *  - and the committed snapshot matches, so a change of the contract cannot
 *    pass unnoticed.
 */

const document = buildOpenApiDocument();
const schemas = document.components.schemas;

const snapshotPath = fileURLToPath(new URL('../openapi.snapshot.json', import.meta.url));

/**
 * The first difference between two serialized documents, with context.
 *
 * The document is ~100 kB, so a structural diff would drown the reader. The
 * first differing LINE is what actually tells a maintainer what changed.
 */
function firstDifference(actual: string, expected: string): string | null {
  if (actual === expected) return null;
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const index = actualLines.findIndex((line, i) => line !== expectedLines[i]);
  const from = Math.max(0, index - 3);
  const to = index + 4;
  const context: string[] = [];
  for (let i = from; i < to; i++) {
    const marker = actualLines[i] === expectedLines[i] ? ' ' : '-';
    context.push(`${marker} ${expectedLines[i] ?? '<missing>'}`);
    if (actualLines[i] !== expectedLines[i]) {
      context.push(`+ ${actualLines[i] ?? '<missing>'}`);
    }
  }
  return [
    `the committed snapshot is stale (first difference on line ${index + 1})`,
    'expected (-) is the committed snapshot, actual (+) is the generated document:',
    ...context,
    '',
    'refresh it with:',
    '  pnpm --filter @vision-lens/contracts run openapi:snapshot',
  ].join('\n');
}

/** Every `$ref` of the document, as a set of strings. */
function collectRefs(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, into);
    return into;
  }
  if (typeof node !== 'object' || node === null) return into;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string') into.add(value);
    else collectRefs(value, into);
  }
  return into;
}

describe('the OpenAPI seed', () => {
  it('declares OpenAPI 3.1 and the contracts version', () => {
    expect(document.openapi).toBe(OPENAPI_VERSION);
    expect(document.openapi).toBe('3.1.0');
    expect(document.jsonSchemaDialect).toBe(OPENAPI_JSON_SCHEMA_DIALECT);
    expect(document.info.title).toBe('Vision Lens');
    expect(document.info.version).toBe(CONTRACTS_VERSION);
  });

  it('is a pure function of the schemas', () => {
    expect(buildOpenApiDocument()).toEqual(buildOpenApiDocument());
    expect(openapiDocument).toEqual(buildOpenApiDocument());
  });

  it('matches the committed snapshot', () => {
    const expected = readFileSync(snapshotPath, 'utf8');
    const actual = serializeOpenApiDocument(document);
    expect(firstDifference(actual, expected)).toBeNull();
  });

  it('publishes every entity of the domain model as a component', () => {
    for (const name of Object.keys(ENTITY_SCHEMAS)) {
      expect(schemas[name], `entity ${name} is missing`).toBeDefined();
      expect(schemas[name].title).toBe(name);
      expect(schemas[name].description, `entity ${name} has no description`).toBeTruthy();
    }
  });

  it('publishes every enum of the domain model as a component', () => {
    for (const name of Object.keys(ENUM_SCHEMAS)) {
      expect(schemas[name], `enum ${name} is missing`).toBeDefined();
      expect(schemas[name].title).toBe(name);
      expect(schemas[name].enum).toEqual([
        ...(ENUM_SCHEMAS as Record<string, { options: readonly string[] }>)[name].options,
      ]);
    }
  });

  it('marks the discriminated unions with a discriminator', () => {
    for (const name of ['Actor', 'AnnotationActor', 'PredictionActor']) {
      const union = schemas[name];
      expect(union.oneOf, `${name} is not a oneOf`).toBeDefined();
      expect(union.anyOf, `${name} still uses anyOf`).toBeUndefined();
      expect(union.discriminator, `${name} has no discriminator`).toBeDefined();
      expect(union.discriminator?.propertyName).toBe('kind');
      expect(Object.keys(union.discriminator?.mapping ?? {}).length).toBe(union.oneOf?.length);
      for (const target of Object.values(union.discriminator?.mapping ?? {})) {
        expect(schemas[target.replace('#/components/schemas/', '')]).toBeDefined();
      }
    }
  });

  it('models the JSON-shaped fields as real JSON Schema', () => {
    const jsonValue = schemas.JsonValue;
    expect(jsonValue).toBeDefined();
    expect(jsonValue.type, 'JsonValue is an opaque string').toBeUndefined();
    const members = jsonValue.anyOf ?? [];
    expect(members.some((member) => member.type === 'object')).toBe(true);
    expect(members.some((member) => member.type === 'array')).toBe(true);

    const asset = schemas.Asset;
    expect(asset.properties?.exifSanitizedJson?.$ref).toBe('#/components/schemas/JsonValue');
    expect(asset.properties?.exifSanitizedJson?.type).toBeUndefined();
  });

  it('describes the required fields accurately', () => {
    expect(schemas.Asset.required).toEqual(['id', 'kind', 'unhashed', 'createdAt']);
    expect(schemas.Asset.properties?.sha256?.$ref).toBe('#/components/schemas/Sha256');
    expect(schemas.Annotation.required).toContain('ontologyVersionId');
    expect(schemas.Prediction.required).toContain('modelVersionId');
    expect(schemas.Prediction.required).not.toContain('ontologyVersionId');
  });

  it('exposes the five CRUD operations of every entity', () => {
    for (const name of Object.keys(ENTITY_SCHEMAS)) {
      const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
      const collection = document.paths[`/${kebab}s`];
      const item = document.paths[`/${kebab}s/{id}`];
      expect(collection, `${name} has no collection path`).toBeDefined();
      expect(item, `${name} has no item path`).toBeDefined();

      const operations = [
        collection?.get,
        collection?.post,
        item?.get,
        item?.put,
        item?.delete,
      ].filter((operation) => operation !== undefined);
      expect(operations).toHaveLength(5);
      for (const operation of operations) {
        expect(operation.operationId.startsWith('spec002Skeleton')).toBe(true);
        expect(operation.tags).toEqual([name]);
        expect(operation.responses['default']).toBeDefined();
      }
    }
  });

  it('resolves every reference of the document', () => {
    const names = new Set(Object.keys(schemas));
    for (const ref of collectRefs(document)) {
      const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
      expect(match, `unexpected reference ${ref}`).not.toBeNull();
      expect(names.has(match?.[1] as string), `dangling reference ${ref}`).toBe(true);
    }
  });

  it('is a valid OpenAPI 3.1 document', () => {
    const validate = createOpenApi31EnvelopeValidator();
    const valid = validate(document);
    expect(valid, formatErrors(validate.errors)).toBe(true);
  });

  it('rejects a document that is not OpenAPI 3.1', () => {
    const validate = createOpenApi31EnvelopeValidator();
    expect(validate({ ...document, openapi: '3.0.0' })).toBe(false);
    const withoutInfo = { ...document } as Record<string, unknown>;
    delete withoutInfo.info;
    expect(validate(withoutInfo)).toBe(false);
  });

  it('publishes every component as a valid JSON Schema 2020-12 schema', () => {
    const components = createComponentValidators(document);
    for (const [name, component] of Object.entries(schemas)) {
      const error = components.validateSchema(component);
      expect(error, `${name} is not a valid JSON Schema: ${error}`).toBeNull();
      const validate = components.compile(name);
      expect(typeof validate).toBe('function');
    }
  });

  it('compiles the entity schemas, so a reference cannot dangle', () => {
    const components = createComponentValidators(document);
    const validate = components.compile('Asset');
    expect(validate({ id: 'not-a-uuid', kind: 'image', unhashed: true, createdAt: 'now' })).toBe(
      false,
    );
  });
});

/**
 * The discriminator is added by a pure post-processing step, so it can be
 * tested on its own — including the case where the union is NOT exclusive
 * and must therefore keep its `anyOf`.
 */
describe('the discriminator transformation', () => {
  it('turns a discriminated union into a oneOf with a mapping', () => {
    const branches: JsonSchemaNode[] = [
      { $ref: '#/components/schemas/Human' },
      { $ref: '#/components/schemas/Model' },
    ];
    const resolved: Record<string, JsonSchemaNode> = {
      '#/components/schemas/Human': { properties: { kind: { const: 'human' } } },
      '#/components/schemas/Model': { properties: { kind: { const: 'model' } } },
    };
    const result = applyDiscriminators({ anyOf: branches }, (ref) => resolved[ref]);
    expect(result.oneOf).toBeDefined();
    expect(result.anyOf).toBeUndefined();
    expect(result.discriminator?.propertyName).toBe('kind');
    expect(result.discriminator?.mapping).toEqual({
      human: '#/components/schemas/Human',
      model: '#/components/schemas/Model',
    });
  });

  it('leaves a union without a discriminator alone', () => {
    const result = applyDiscriminators(
      { anyOf: [{ type: 'string' }, { type: 'number' }] },
      () => undefined,
    );
    expect(result.oneOf).toBeUndefined();
    expect(result.anyOf).toHaveLength(2);
    expect(result.discriminator).toBeUndefined();
  });

  it('does not mark a union with duplicate constants as exclusive', () => {
    const branches: JsonSchemaNode[] = [
      { $ref: '#/components/schemas/First' },
      { $ref: '#/components/schemas/Second' },
    ];
    const resolved: Record<string, JsonSchemaNode> = {
      '#/components/schemas/First': { properties: { kind: { const: 'human' } } },
      '#/components/schemas/Second': { properties: { kind: { const: 'human' } } },
    };
    const result = applyDiscriminators({ anyOf: branches }, (ref) => resolved[ref]);
    expect(result.discriminator).toBeUndefined();
    expect(result.anyOf).toHaveLength(2);
  });
});

/**
 * The snapshot and the build artefact are written from the same document, so
 * they can never disagree.
 */
describe('the published document', () => {
  it('is the document the generator produces', () => {
    const published: OpenApiDocument = JSON.parse(
      readFileSync(snapshotPath, 'utf8'),
    ) as OpenApiDocument;
    expect(published).toEqual(document);
  });
});
