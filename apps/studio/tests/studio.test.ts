import { describe, expect, it } from 'vitest';
import { studioPlaceholder } from '../src/index.js';

describe('studio placeholder', () => {
  it('returns the spec 010 placeholder string', () => {
    expect(studioPlaceholder()).toBe('master-vision studio placeholder (spec 010)');
  });
});
