import { describe, expect, it } from 'vitest';
import { buildFeedbackNote } from '../../src/utils/feedback.js';
import type { ReviewOverride } from '../../src/types.js';

function override(from: string, to: string): ReviewOverride {
  return { file: 'img.jpg', originalCategory: from, overriddenCategory: to };
}

describe('buildFeedbackNote', () => {
  it('returns empty string for empty overrides', () => {
    expect(buildFeedbackNote([])).toBe('');
  });

  it('returns empty string when no pattern reaches threshold (< 3)', () => {
    const overrides = [override('kitchen', 'bathroom'), override('kitchen', 'bathroom')];
    expect(buildFeedbackNote(overrides)).toBe('');
  });

  it('includes note when a pattern appears 3+ times', () => {
    const overrides = [
      override('kitchen', 'bathroom'),
      override('kitchen', 'bathroom'),
      override('kitchen', 'bathroom'),
    ];
    const note = buildFeedbackNote(overrides);
    expect(note).toContain('kitchen');
    expect(note).toContain('bathroom');
    expect(note).toContain('3 times');
  });

  it('counts occurrences separately per distinct pattern', () => {
    const overrides = [
      override('kitchen', 'bathroom'),
      override('kitchen', 'bathroom'),
      override('kitchen', 'bathroom'),
      override('lounge', 'living_room'),
      override('lounge', 'living_room'),
      override('lounge', 'living_room'),
      override('lounge', 'living_room'),
    ];
    const note = buildFeedbackNote(overrides);
    expect(note).toContain('bathroom');
    expect(note).toContain('living_room');
    expect(note).toContain('4 times');
  });

  it('ignores patterns below the 3-occurrence threshold', () => {
    const overrides = [
      override('kitchen', 'bathroom'),
      override('kitchen', 'bathroom'),
      override('kitchen', 'bathroom'),
      override('lounge', 'living_room'),
      override('lounge', 'living_room'), // only 2 — should be ignored
    ];
    const note = buildFeedbackNote(overrides);
    expect(note).toContain('bathroom');
    expect(note).not.toContain('living_room');
  });
});
