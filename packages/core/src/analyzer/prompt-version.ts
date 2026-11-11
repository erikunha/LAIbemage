/**
 * The version of the analyzer's prompt template.
 *
 * The prompt is part of the experiment: a report that names the wrong prompt
 * version attributes its number to the wrong experiment. Both fingerprints
 * that hash a prompt — the analysis fingerprint (`packages/core/src/index.ts`)
 * and the benchmark's config fingerprint
 * (`packages/core/src/benchmark/config-fingerprint.ts`) — read it from HERE,
 * so the two cannot drift apart.
 *
 * Bump it when the text of the analyzer's system prompt changes.
 */
export const PROMPT_TEMPLATE_VERSION = 'prompt-v1';
