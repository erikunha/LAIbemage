import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/**
 * Validators for the generated OpenAPI document.
 *
 * Two different things are checked, with two different schemas, because they
 * are two different claims:
 *
 *  1. **The document is a real OpenAPI 3.1 document.** That is checked
 *     against the official OpenAPI 3.1 JSON Schema
 *     (`@apidevtools/openapi-schemas`, the schema the OpenAPI Initiative
 *     publishes). It proves the ENVELOPE is right: the version, the info
 *     object, the shape of the paths, the shape of the operations.
 *  2. **Every component is a real JSON Schema 2020-12 schema.** That is
 *     checked against the JSON Schema 2020-12 metaschema, and every reference
 *     inside the document is resolved while compiling, so a dangling `$ref`
 *     fails the check instead of silently shipping.
 *
 * The first check does NOT validate the contents of a Schema Object: the
 * OpenAPI schema accepts any JSON Schema there, and delegates that to the
 * dialect. The second check is what covers the contents.
 */

const require = createRequire(import.meta.url);

/** The official OpenAPI 3.1 JSON Schema. */
const OPENAPI_31_SCHEMA = '@apidevtools/openapi-schemas/schemas/v3.1/schema.json';

/** The `$id` the generated document is registered under while validating. */
export const DOCUMENT_SCHEMA_ID = 'urn:master-vision:openapi';

/** Reads a JSON module of a package as a plain object. */
function readJsonModule(specifier: string): Record<string, unknown> {
  return JSON.parse(readFileSync(require.resolve(specifier), 'utf8')) as Record<string, unknown>;
}

/** Formats the errors of a failed validation into a readable message. */
export function formatErrors(errors: readonly ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'no error details';
  return errors
    .map((error) => `${error.instancePath || '/'} ${error.message ?? ''}`.trim())
    .join('\n');
}

/**
 * A validator for the OpenAPI 3.1 envelope.
 *
 * The official schema uses `$dynamicRef` to point at the OpenAPI Schema
 * Object dialect. Ajv resolves the dynamic anchor against the schema that
 * declares it, which would make the check depend on the dialect being loaded
 * as a separate resource. The canonical workaround — the same one
 * `@apidevtools/swagger-parser` uses — drops the dynamic anchor and points
 * the four Schema Object positions at the Schema Object definition directly.
 *
 * The consequence, stated plainly: this validator checks the ENVELOPE of the
 * document. The CONTENTS of the Schema Objects are checked separately, as
 * JSON Schema 2020-12, by {@link createComponentValidators}.
 */
export function createOpenApi31EnvelopeValidator(): ValidateFunction {
  const schema = readJsonModule(OPENAPI_31_SCHEMA) as {
    $defs: Record<string, Record<string, unknown>>;
  };

  const schemaDefinition = schema.$defs.schema;
  delete schemaDefinition.$dynamicAnchor;
  schema.$defs.components.properties.schemas.additionalProperties = schemaDefinition;
  schema.$defs.header.dependentSchemas.schema.properties.schema = schemaDefinition;
  schema.$defs['media-type'].properties.schema = schemaDefinition;
  schema.$defs.parameter.properties.schema = schemaDefinition;

  const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
  return ajv.compile(schema);
}

/**
 * Validators for the components of a document.
 *
 * The whole document is registered as one schema under
 * {@link DOCUMENT_SCHEMA_ID}, so that the `$ref`s between the components
 * resolve exactly as they do in the published document. Compiling a
 * component therefore proves both that the component is a valid JSON Schema
 * 2020-12 schema and that its references resolve.
 */
export function createComponentValidators(document: unknown): {
  validateSchema: (component: unknown) => string | null;
  compile: (name: string) => ValidateFunction;
} {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema({ $id: DOCUMENT_SCHEMA_ID, ...(document as object) });

  return {
    validateSchema(component: unknown): string | null {
      if (ajv.validateSchema(component)) return null;
      return formatErrors(ajv.errors);
    },
    compile(name: string): ValidateFunction {
      return ajv.compile({ $ref: `${DOCUMENT_SCHEMA_ID}#/components/schemas/${name}` });
    },
  };
}
