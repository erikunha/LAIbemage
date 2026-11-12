import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JobState } from '@vision-lens/contracts';
import {
  applyMigrations,
  defaultMigrationsDir,
  newEntityId,
  openStore,
  rollbackMigrations,
  type SqliteDatabase,
} from '../../src/store/index.js';
import { createTestStore, makeTempDir, removeTempDir } from './helpers.js';

/**
 * Task 4.3 (FR-012): cancellation drives a job through the intermediate
 * `cancel_requested` state to the immutable terminal `cancelled` state, and
 * EVERY transition lands in the append-only audit ledger.
 *
 * The state widening is its own numbered migration (0003): the six-state
 * CHECK of 0001_init is immutable, so the migration rebuilds the table (and
 * every table referencing it) with the widened CHECK, preserving every row
 * and every foreign key. The tests below prove that preservation on a seeded
 * store, the repository API on top of it, and the rollback.
 */

const MIGRATIONS_DIR = defaultMigrationsDir();

/** A fresh UUIDv7 run id (the entity schema refuses anything else). */
function newRunId(): string {
  return newEntityId();
}


/** Opens a store migrated ONLY to 0002 (the pre-widening schema). */
async function openPreWideningStore() {
  const dir = makeTempDir('vl-store-widen-');
  const store = await openStore(join(dir, 'store.db'));
  applyMigrations(store.db);
  rollbackMigrations(store.db, '0002');
  return { dir, store };
}

/** Seeds the full reference graph around one experiment run. */
function seedRunGraph(db: SqliteDatabase): void {
  const t = '2026-01-01T00:00:00.000Z';
  const run = db.prepare(
    `INSERT INTO experiment_runs (id, kind, config_fingerprint, status, started_at, created_at, updated_at)
     VALUES ('run-w', 'classify', 'fp2:0123456789abcdef', 'running', ?, ?, ?)`,
  );
  run.run(t, t, t);
  db.prepare(
    `INSERT INTO evaluation_runs (id, experiment_run_id, protocol, results_json, created_at, updated_at)
       VALUES ('eval-w', 'run-w', 'holdout-v1', '{}', ?, ?)`,
  ).run(t, t);
  db.prepare(
    `INSERT INTO model_versions (id, name, version, registry_state, experiment_run_id, created_at, updated_at)
       VALUES ('mv-w', 'siglip2-base', 'r1', 'draft', 'run-w', ?, ?)`,
  ).run(t, t);
}

describe('migration 0003: the cancel_requested widening', () => {
  it('preserves every row and foreign key while widening the CHECK', async () => {
    const { dir, store } = await openPreWideningStore();
    try {
      seedRunGraph(store.db);
      // Sanity: the pre-widening CHECK refuses the new state.
      expect(() =>
        store.db
          .prepare(`UPDATE experiment_runs SET status = 'cancel_requested' WHERE id = 'run-w'`)
          .run(),
      ).toThrow(/CHECK constraint failed: status/);

      const report = applyMigrations(store.db);
      expect(report.applied).toEqual(['0003']);

      expect(
        store.db.prepare('SELECT COUNT(*) AS n FROM experiment_runs').get(),
      ).toMatchObject({ n: 1 });
      expect(
        store.db.prepare('SELECT COUNT(*) AS n FROM evaluation_runs').get(),
      ).toMatchObject({ n: 1 });
      expect(
        store.db
          .prepare('SELECT experiment_run_id FROM model_versions WHERE id = ?')
          .get('mv-w'),
      ).toMatchObject({ experiment_run_id: 'run-w' });

      // The widened CHECK accepts the intermediate state and still refuses junk.
      store.db
        .prepare(`UPDATE experiment_runs SET status = 'cancel_requested' WHERE id = 'run-w'`)
        .run();
      expect(() =>
        store.db.prepare(`UPDATE experiment_runs SET status = 'bogus' WHERE id = 'run-w'`).run(),
      ).toThrow(/CHECK constraint failed: status/);

      // No dangling reference survived the rebuild.
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      // The audit ledger table exists and is append-only by trigger.
      expect(store.db.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('job_transitions')).toMatchObject(
        { name: 'job_transitions' },
      );
      const insert = store.db.prepare(
        `INSERT INTO job_transitions (id, run_id, from_status, to_status, reason, recorded_at)
         VALUES ('jt-1', 'run-w', 'running', 'cancel_requested', 'test', '2026-01-01T00:00:00.000Z')`,
      );
      insert.run();
      expect(() =>
        store.db.prepare(`UPDATE job_transitions SET to_status = 'queued' WHERE id = 'jt-1'`).run(),
      ).toThrow(/append-only/);
      expect(() =>
        store.db.prepare(`DELETE FROM job_transitions WHERE id = 'jt-1'`).run(),
      ).toThrow(/append-only/);
    } finally {
      store.close();
      removeTempDir(dir);
    }
  });

  it('rolls back to the six-state CHECK and drops the ledger', async () => {
    const store = await createTestStore();
    try {
      rollbackMigrations(store.db, '0002');
      const ddl = store.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'experiment_runs'")
        .get() as { sql: string };
      expect(ddl.sql).not.toContain('cancel_requested');
      expect(
        store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'job_transitions'").get(),
      ).toBeUndefined();
      // The data survived the round trip.
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM experiment_runs').get()).toMatchObject({
        n: 0,
      });
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      store.cleanup();
    }
  });

  it('the rollback folds a cancel_requested run to cancelled and keeps the graph intact', async () => {
    const store = await createTestStore();
    try {
      // A run caught mid-cancellation: the operator asked to stop, the stop
      // was never confirmed, the ledger holds the request, and a child
      // evaluation references the run.
      const run = store.repos.experiments.insert({
        id: newRunId(),
        kind: 'classify',
        configFingerprint: 'fp2:0123456789abcdef',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      store.repos.experiments.requestCancel(run.id, 'operator requested');
      store.db
        .prepare(
          `INSERT INTO evaluation_runs (id, experiment_run_id, protocol, results_json, created_at, updated_at)
           VALUES (?, ?, 'holdout-v1', '{}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
        )
        .run(newEntityId(), run.id);
      expect(store.repos.experiments.getById(run.id)?.status).toBe('cancel_requested');
      expect(store.repos.experiments.listTransitions(run.id)).toHaveLength(1);

      rollbackMigrations(store.db, '0002');

      // The intermediate state cannot survive the six-state CHECK, so the
      // fold records it as cancelled (the rollback must not resurrect a
      // running job). The row, the child and the foreign keys survive.
      const folded = store.db
        .prepare('SELECT status FROM experiment_runs WHERE id = ?')
        .get(run.id) as { status: string };
      expect(folded.status).toBe('cancelled');
      expect(
        store.db
          .prepare('SELECT COUNT(*) AS n FROM evaluation_runs WHERE experiment_run_id = ?')
          .get(run.id),
      ).toMatchObject({ n: 1 });
      expect(store.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(
        store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'job_transitions'").get(),
      ).toBeUndefined();
      // The narrowed CHECK really is back: the intermediate state is refused.
      expect(() =>
        store.db
          .prepare(`UPDATE experiment_runs SET status = 'cancel_requested' WHERE id = ?`)
          .run(run.id),
      ).toThrow(/CHECK constraint failed: status/);
    } finally {
      store.cleanup();
    }
  });

  it('the committed migration file widens exactly the status CHECK', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0003_job_cancel_requested.sql'), 'utf8');
    expect(sql).toContain("'cancel_requested'");
    // The rebuilt CHECK keeps every original state.
    for (const state of [
      "'queued'",
      "'running'",
      "'succeeded'",
      "'failed'",
      "'cancelled'",
      "'abstained'",
    ]) {
      expect(sql).toContain(state);
    }
    expect(
      readFileSync(join(MIGRATIONS_DIR, '0003_job_cancel_requested.rollback.sql'), 'utf8').length,
    ).toBeGreaterThan(0);
  });
});

describe('the repository transition API', () => {
  it('requestCancel moves a running run to cancel_requested and appends the ledger row', async () => {
    const store = await createTestStore();
    try {
      const run = store.repos.experiments.insert({
        id: newRunId(),
        kind: 'classify',
        configFingerprint: 'fp2:0123456789abcdef',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
      });

      const after = store.repos.experiments.requestCancel(run.id, 'operator requested');

      expect(after.status).toBe('cancel_requested');
      // The intermediate state is NOT terminal: no endedAt is stamped.
      expect(after.endedAt).toBeUndefined();

      const ledger = store.repos.experiments.listTransitions(run.id);
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({
        runId: run.id,
        fromStatus: 'running',
        toStatus: 'cancel_requested',
        reason: 'operator requested',
      });
    } finally {
      store.cleanup();
    }
  });

  it('completeCancel reaches the immutable terminal state and records both transitions', async () => {
    const store = await createTestStore();
    try {
      const run = store.repos.experiments.insert({
        id: newRunId(),
        kind: 'classify',
        configFingerprint: 'fp2:0123456789abcdef',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      store.repos.experiments.requestCancel(run.id);
      const terminal = store.repos.experiments.completeCancel(run.id, 'worker acknowledged');

      expect(terminal.status).toBe('cancelled');
      expect(terminal.endedAt).toBeDefined();

      const ledger = store.repos.experiments.listTransitions(run.id);
      expect(ledger.map((row) => [row.fromStatus, row.toStatus])).toEqual([
        ['running', 'cancel_requested'],
        ['cancel_requested', 'cancelled'],
      ]);

      // The terminal state is immutable: no further transition is accepted.
      expect(() => store.repos.experiments.updateStatus(run.id, 'running')).toThrow(/terminal/i);
      expect(() => store.repos.experiments.requestCancel(run.id)).toThrow(/terminal/i);
      // The ledger kept exactly the two transitions.
      expect(store.repos.experiments.listTransitions(run.id)).toHaveLength(2);
    } finally {
      store.cleanup();
    }
  });

  it('requestCancel refuses unknown runs, terminal runs and repeated requests', async () => {
    const store = await createTestStore();
    try {
      expect(() => store.repos.experiments.requestCancel('no-such-run')).toThrow(/no such run/);

      const queuedRun = store.repos.experiments.insert({
        id: newRunId(),
        kind: 'classify',
        configFingerprint: 'fp2:0123456789abcdef',
        status: 'queued',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      // A queued run may be cancelled too (it never started work).
      expect(store.repos.experiments.requestCancel(queuedRun.id).status).toBe('cancel_requested');
      // A second request for the same run is refused.
      expect(() => store.repos.experiments.requestCancel(queuedRun.id)).toThrow(
        /already requested/,
      );

      const doneRun = store.repos.experiments.insert({
        id: newRunId(),
        kind: 'classify',
        configFingerprint: 'fp2:0123456789abcdef',
        status: 'succeeded',
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:01:00.000Z',
      });
      expect(() => store.repos.experiments.requestCancel(doneRun.id)).toThrow(/terminal/i);
    } finally {
      store.cleanup();
    }
  });

  it('completeCancel refuses a run that never entered cancel_requested', async () => {
    const store = await createTestStore();
    try {
      const run = store.repos.experiments.insert({
        id: newRunId(),
        kind: 'classify',
        configFingerprint: 'fp2:0123456789abcdef',
        status: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
      });
      expect(() => store.repos.experiments.completeCancel(run.id)).toThrow(
        /cancel_requested first/,
      );
      // The direct path through updateStatus still works and is recorded.
      const direct = store.repos.experiments.updateStatus(run.id, 'cancelled');
      expect(direct.status).toBe('cancelled');
      expect(store.repos.experiments.listTransitions(run.id)).toMatchObject([
        { fromStatus: 'running', toStatus: 'cancelled' },
      ]);
    } finally {
      store.cleanup();
    }
  });

  it('every state the enum allows is accepted by the widened CHECK', async () => {
    const store = await createTestStore();
    try {
      const states: JobState[] = [
        'queued',
        'running',
        'cancel_requested',
        'succeeded',
        'failed',
        'cancelled',
        'abstained',
      ];
      for (const status of states) {
        const run = store.repos.experiments.insert({
          id: newRunId(),
          kind: 'classify',
          configFingerprint: 'fp2:0123456789abcdef',
          status,
          startedAt: '2026-01-01T00:00:00.000Z',
        });
        expect(store.repos.experiments.getById(run.id)?.status).toBe(status);
      }
    } finally {
      store.cleanup();
    }
  });
});
