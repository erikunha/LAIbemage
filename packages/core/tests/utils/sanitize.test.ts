import { describe, expect, it } from 'vitest';
import { sanitizeTextField } from '../../src/utils/sanitize.js';

describe('sanitizeTextField', () => {
  it('trims leading and trailing whitespace', () => {
    expect(sanitizeTextField('  hello world  ', 200)).toBe('hello world');
  });

  it('removes null bytes', () => {
    expect(sanitizeTextField('hello\x00world', 200)).toBe('helloworld');
  });

  it('removes forward slashes to prevent path traversal', () => {
    expect(sanitizeTextField('../../../etc/passwd', 200)).toBe('......etcpasswd');
  });

  it('removes back slashes to prevent Windows path traversal', () => {
    expect(sanitizeTextField('..\\Windows\\System32', 200)).toBe('..WindowsSystem32');
  });

  it('caps the string at maxLength', () => {
    const long = 'a'.repeat(300);
    expect(sanitizeTextField(long, 200)).toHaveLength(200);
  });

  it('applies maxLength after removing slashes', () => {
    const value = '/'.repeat(10) + 'abc';
    expect(sanitizeTextField(value, 3)).toBe('abc');
  });

  it('returns empty string when all characters are removed', () => {
    expect(sanitizeTextField('\x00\x00', 200)).toBe('');
  });

  it('leaves normal text unchanged', () => {
    expect(sanitizeTextField('Cracked tile in bathroom floor', 200)).toBe(
      'Cracked tile in bathroom floor',
    );
  });
});
