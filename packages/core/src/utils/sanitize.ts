/**
 * Sanitises a free-text field coming from an LLM response before it is
 * persisted to cache or used to construct file names.
 *
 * Removes:
 *  - Null bytes (which can truncate strings in some runtime contexts)
 *  - Forward- and back-slashes (prevent path traversal in output filenames)
 *
 * Also trims whitespace and caps the string at `maxLength` characters.
 */

// eslint-disable-next-line no-control-regex
const NULL_BYTES_RE = /\x00/g;
const PATH_TRAVERSAL_RE = /[/\\]/g;

export function sanitizeTextField(value: string, maxLength: number): string {
  return value.replace(NULL_BYTES_RE, '').replace(PATH_TRAVERSAL_RE, '').trim().slice(0, maxLength);
}
