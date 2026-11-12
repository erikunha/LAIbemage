import { describe, expect, it } from 'vitest';
import { formatImportRunSummary } from '../src/commands/import-run.js';
import type { LegacyImportResult } from '@vision-lens/core/store';

/**
 * The output shape of `vision-lens import-run` (spec 002, task 4.3).
 *
 * Pure formatting: no store, no I/O. The command prints ONE LINE PER COUNT,
 * and the dry run prints the SAME lines as the real import — a dry run is a
 * preview, not an estimate.
 */

const RESULT: LegacyImportResult = {
  manifestId: 'a'.repeat(64),
  shape: 'flat-cache',
  runPath: '/tmp/run/analysis_results.json',
  counts: {
    assets: 4,
    assetsHashed: 2,
    assetsUnhashed: 2,
    samples: 4,
    predictions: 4,
    annotations: 1,
    captureSessions: 2,
    ontologyVersions: 1,
    modelVersions: 1,
    experimentRuns: 1,
    legacyCarryOvers: 4,
    legacyConditions: 4,
    skippedRecords: 0,
    unmatchedOverrides: 0,
  },
  alreadyImported: false,
  wrote: true,
  dryRun: false,
};

describe('import-run output', () => {
  it('prints one line per count', () => {
    const lines = formatImportRunSummary(RESULT, { dbPath: '/tmp/store.db', dryRun: false });

    expect(lines).toContain('assets:          4 (hashed 2, unhashed 2)');
    expect(lines).toContain('samples:         4');
    expect(lines).toContain('predictions:     4');
    expect(lines).toContain('annotations:     1');
    expect(lines).toContain('capture sessions:2');
    expect(lines).toContain('ontology versions:1');
    expect(lines).toContain('model versions:  1');
    expect(lines).toContain('experiment runs: 1');
    expect(lines).toContain('legacy carry-overs: 4');
    expect(lines).toContain('legacy conditions:4');
    expect(lines).toContain(`manifest id:     ${'a'.repeat(64)}`);
    expect(lines).toContain('shape:           flat-cache');
  });

  it('prints the SAME counts in a dry run and in a real import', () => {
    const dry = formatImportRunSummary({ ...RESULT, dryRun: true }, { dbPath: '/tmp/store.db', dryRun: true });
    const real = formatImportRunSummary(RESULT, { dbPath: '/tmp/store.db', dryRun: false });

    const countLines = (lines: string[]): string[] =>
      lines.filter((line) => /^(assets|samples|predictions|annotations|capture|ontology|model|experiment|legacy)/.test(line));

    expect(countLines(dry)).toEqual(countLines(real));
    expect(dry.some((line) => line.includes('dry run — nothing was written'))).toBe(true);
    expect(real.some((line) => line.includes('imported'))).toBe(true);
  });

  it('says when the run was already imported', () => {
    const lines = formatImportRunSummary(
      { ...RESULT, alreadyImported: true, wrote: false },
      { dbPath: '/tmp/store.db', dryRun: false },
    );
    expect(lines.some((line) => line.includes('already imported — nothing was written'))).toBe(true);
  });

  it('prints the anomaly counters only when they are not zero', () => {
    const clean = formatImportRunSummary(RESULT, { dbPath: '/tmp/store.db', dryRun: false });
    expect(clean.some((line) => line.startsWith('skipped records'))).toBe(false);
    expect(clean.some((line) => line.startsWith('unmatched overrides'))).toBe(false);

    const dirty = formatImportRunSummary(
      {
        ...RESULT,
        counts: { ...RESULT.counts, skippedRecords: 2, unmatchedOverrides: 1 },
      },
      { dbPath: '/tmp/store.db', dryRun: false },
    );
    expect(dirty.some((line) => line.startsWith('skipped records'))).toBe(true);
    expect(dirty.some((line) => line.startsWith('unmatched overrides'))).toBe(true);
  });
});
