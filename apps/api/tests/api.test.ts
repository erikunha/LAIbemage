import { describe, expect, it } from 'vitest';
import { apiPlaceholder } from '../src/index.js';

describe('api placeholder', () => {
  it('returns the spec 009 placeholder string', () => {
    expect(apiPlaceholder()).toBe('vision-lens api placeholder (spec 009)');
  });
});
