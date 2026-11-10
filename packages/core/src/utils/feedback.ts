import type { ReviewOverride } from '../types.js';

const MIN_OCCURRENCES = 3;

/**
 * Analyzes override patterns from previous runs and returns a feedback note
 * to inject into the batch prompt when --learn is active.
 * Returns an empty string if there are no strong patterns.
 */
export function buildFeedbackNote(overrides: readonly ReviewOverride[]): string {
  if (overrides.length === 0) return '';

  const patternCounts = new Map<string, number>();
  for (const o of overrides) {
    const key = `${o.originalCategory}→${o.overriddenCategory}`;
    patternCounts.set(key, (patternCounts.get(key) ?? 0) + 1);
  }

  const notes: string[] = [];
  for (const [pattern, count] of patternCounts) {
    if (count < MIN_OCCURRENCES) continue;
    const [from, to] = pattern.split('→') as [string, string];
    notes.push(
      `Note: images previously classified as "${from}" were consistently corrected to "${to}" (${count} times).`,
    );
  }

  if (notes.length === 0) return '';

  return `\n\nLearned corrections from previous runs:\n${notes.join('\n')}`;
}
