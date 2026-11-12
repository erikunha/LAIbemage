import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The optional-dependency guard (spec 002, edge case: "better-sqlite3 absent
 * (optional dep, spec 001) → repos fail fast with actionable install
 * message").
 *
 * `better-sqlite3` is an optional dependency of `@vision-lens/core`: it is
 * a NATIVE module and must never be a hard import. The mock below simulates a
 * machine where the package is NOT installed, without uninstalling anything
 * (the same technique the reporter's own guard test uses).
 */
vi.mock('better-sqlite3', () => {
  throw new Error("Cannot find package 'better-sqlite3' (mocked absence)");
});

describe('the optional dependency guard', () => {
  it('throws an actionable error when better-sqlite3 is absent', async () => {
    const { openStore } = await import('../../src/store/index.js');

    await expect(openStore(path.join('/tmp', 'never-created.db'))).rejects.toThrow(
      /better-sqlite3 is not installed[\s\S]*pnpm add better-sqlite3/,
    );
  });

  it('surfaces the actionable error for an injected driver factory that fails', async () => {
    const { openStore, StoreUnavailableError } = await import('../../src/store/index.js');

    const failure = await openStore(path.join('/tmp', 'never-created.db'), {
      driver: () => {
        throw new Error('native binding missing');
      },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StoreUnavailableError);
    expect((failure as Error).message).toContain('better-sqlite3 is not installed');
    expect((failure as Error).cause).toBeDefined();
  });

  it('computes a default path without touching the home directory', async () => {
    const { defaultStorePath } = await import('../../src/store/index.js');
    const previous = process.env['VISION_LENS_HOME'];
    try {
      process.env['VISION_LENS_HOME'] = '/tmp/vision-lens-home';
      expect(defaultStorePath()).toBe(path.join('/tmp/vision-lens-home', 'store.db'));

      delete process.env['VISION_LENS_HOME'];
      // The fallback is the user's home directory — the function only
      // COMPUTES the path, it never creates or writes anything.
      expect(defaultStorePath().endsWith(path.join('.vision-lens', 'store.db'))).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env['VISION_LENS_HOME'];
      } else {
        process.env['VISION_LENS_HOME'] = previous;
      }
    }
  });
});
