import { describe, expect, it } from 'vitest';
import { CONTRACTS_VERSION, UnitSeededSchema } from '../src/index.js';

describe('@vision-lens/contracts', () => {
  it('exposes CONTRACTS_VERSION in semver format', () => {
    expect(CONTRACTS_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('round-trips a valid UnitSeeded payload through the schema', () => {
    const sample = {
      id: '3b241101-e2bb-4255-8caf-4136c566a962',
      createdAt: '2026-11-10T12:00:00.000Z',
    };
    const parsed = UnitSeededSchema.parse(sample);
    expect(parsed).toEqual(sample);
  });

  it('rejects an invalid UnitSeeded payload', () => {
    expect(() =>
      UnitSeededSchema.parse({ id: 'not-a-uuid', createdAt: 'not-a-timestamp' }),
    ).toThrow();
  });
});
