import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildContractManifest,
  checkVersionBump,
  diffManifests,
  majorVersion,
  type ContractManifest,
} from '../src/index.js';

/**
 * CI guard for the contracts version (spec 002 task 1.4, FR-001).
 *
 * A breaking change to the contract surface MUST bump the MAJOR version of
 * `CONTRACTS_VERSION`. The guard is built from three pieces:
 *
 *  1. a MANIFEST derived from the live schemas (`buildContractManifest`),
 *     committed at `packages/contracts/contract-manifest.json`;
 *  2. a PURE comparison function (`diffManifests` / `checkVersionBump`) that
 *     classifies the differences — no git, no filesystem, no clock;
 *  3. a test that reads the BASE manifest from git and applies (2).
 *
 * The classification rule, stated once so the expectations below read as
 * checks of that rule rather than as arbitrary assertions:
 *
 *   BREAKING   — the change NARROWS the contract: an entity or field
 *                disappears, a field changes shape, a field's validation
 *                constraint tightens, a field becomes (or is added as)
 *                required, or an enum value is removed.
 *   COMPATIBLE — the change WIDENS the contract: a new entity, a new
 *                optional field, a field demoted to optional, or a new enum
 *                value. Every payload that validated before still validates.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('../contract-manifest.json', import.meta.url));

const REGENERATE_COMMAND = 'corepack pnpm --filter @vision-lens/contracts run manifest:generate';

/** Runs a git command in the repository root, returning null on failure. */
function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** The revision the contracts surface is compared against: the merge base with origin/main. */
function baseRevision(): string | null {
  for (const ref of ['origin/main', 'main']) {
    const mergeBase = git(['merge-base', ref, 'HEAD']);
    if (mergeBase) return mergeBase;
  }
  return null;
}

/** The manifest as committed at a given revision, or null when absent. */
function manifestAt(revision: string): ContractManifest | null {
  const raw = git(['show', `${revision}:packages/contracts/contract-manifest.json`]);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ContractManifest;
  } catch {
    return null;
  }
}

describe('contract manifest', () => {
  it('committed manifest matches the live schemas', () => {
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ContractManifest;
    const generated = buildContractManifest();

    expect(
      committed,
      `contract-manifest.json is stale — regenerate it with: ${REGENERATE_COMMAND}`,
    ).toEqual(generated);
  });

  it('records the current contracts version', () => {
    const committed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as ContractManifest;
    const generated = buildContractManifest();

    expect(committed.contractsVersion).toBe(generated.contractsVersion);
    expect(majorVersion(committed.contractsVersion)).toBeGreaterThan(0);
  });

  it('captures the validation constraint of a constrained field', () => {
    const generated = buildContractManifest();

    // The sha256 digest format is a written constraint, not a type: a
    // tightened pattern must show up in the manifest, or the guard would
    // treat a tightened digest format as "no change".
    expect(generated.entities.Asset.fields.sha256?.constraint).toBe('pattern=^[0-9a-f]{64}$');
    expect(generated.entities.Asset.fields.bytes?.constraint).toBe('minimum=0');
  });
});

describe('breaking-change guard against the base revision', () => {
  it('requires a MAJOR bump when the contract surface changed in a breaking way', (ctx) => {
    const revision = baseRevision();
    if (revision === null) {
      ctx.skip(
        'NOT RUN: the merge-base with origin/main could not be resolved (no git remote or no base branch). The base-vs-current breaking-diff comparison could not be executed.',
      );
      return;
    }

    const base = manifestAt(revision);
    if (base === null) {
      ctx.skip(
        `NOT RUN: no contract manifest at the base revision ${revision} (packages/contracts/contract-manifest.json does not exist there — the contracts package is not on the base branch yet). The base-vs-current breaking-diff comparison could not be executed; the pure comparison function is unit-tested separately below.`,
      );
      return;
    }

    const current = buildContractManifest();
    const check = checkVersionBump(base, current);

    expect(
      check.breaking.map((change) => `${change.kind}: ${change.path} — ${change.detail}`),
      `Breaking change(s) against the base revision ${revision} require a MAJOR CONTRACTS_VERSION bump. ${check.reason}`,
    ).toEqual([]);
    expect(check.ok).toBe(true);
  });
});

describe('pure comparison function', () => {
  const base: ContractManifest = {
    contractsVersion: '1.0.0',
    entities: {
      Asset: {
        fields: {
          id: { required: true, type: 'uuid' },
          sha256: { required: false, type: 'string' },
        },
      },
    },
    enums: {
      JobState: ['queued', 'running'],
    },
  };

  it('classifies a removed field as breaking', () => {
    const current: ContractManifest = {
      ...base,
      entities: {
        Asset: { fields: { id: { required: true, type: 'uuid' } } },
      },
    };

    const diff = diffManifests(base, current);

    expect(diff.breaking).toHaveLength(1);
    expect(diff.breaking[0].kind).toBe('field-removed');
    expect(diff.breaking[0].path).toBe('Asset.sha256');
    expect(diff.additive).toEqual([]);
  });

  it('classifies an added optional field as compatible, not breaking', () => {
    const current: ContractManifest = {
      ...base,
      entities: {
        Asset: {
          fields: {
            ...base.entities.Asset.fields,
            path: { required: false, type: 'string' },
          },
        },
      },
    };

    const diff = diffManifests(base, current);

    expect(diff.breaking).toEqual([]);
    expect(diff.additive).toContain('Asset.path');
  });

  it('classifies a WIDENED field enum as compatible, not a type change', () => {
    // The JobState widening of spec 018 (migration 0003): a new value in a
    // field's enum accepts every payload the base accepted. The guard's own
    // rule for named enums ("a new enum value appeared: a payload that used
    // to validate still does") must hold inside a field type too.
    const current: ContractManifest = {
      ...base,
      entities: {
        Asset: {
          fields: {
            ...base.entities.Asset.fields,
            state: { required: true, type: 'enum("queued"|"running"|"cancel_requested")' },
          },
        },
      },
    };
    const widened: ContractManifest = {
      ...current,
      entities: {
        Asset: {
          fields: {
            ...current.entities.Asset.fields,
            state: { required: true, type: 'enum("queued"|"running")' },
          },
        },
      },
    };

    const diff = diffManifests(widened, current);

    expect(diff.breaking).toEqual([]);
    expect(diff.additive).toContain('Asset.state widened its value set');
    // The same move in the OTHER direction (a value removed) stays breaking.
    const narrowed = diffManifests(current, widened);
    expect(narrowed.breaking.map((change) => change.kind)).toContain('field-type-changed');
    expect(narrowed.breaking.map((change) => change.path)).toContain('Asset.state');
  });

  it('classifies an added REQUIRED field as breaking', () => {
    const current: ContractManifest = {
      ...base,
      entities: {
        Asset: {
          fields: {
            ...base.entities.Asset.fields,
            path: { required: true, type: 'string' },
          },
        },
      },
    };

    const diff = diffManifests(base, current);

    expect(diff.breaking).toHaveLength(1);
    expect(diff.breaking[0].kind).toBe('field-became-required');
    expect(diff.breaking[0].path).toBe('Asset.path');
    expect(diff.additive).toEqual([]);
  });

  it('classifies a field that became required as breaking', () => {
    const current: ContractManifest = {
      ...base,
      entities: {
        Asset: {
          fields: {
            id: { required: true, type: 'uuid' },
            sha256: { required: true, type: 'string' },
          },
        },
      },
    };

    const diff = diffManifests(base, current);

    expect(diff.breaking).toHaveLength(1);
    expect(diff.breaking[0].kind).toBe('field-became-required');
    expect(diff.breaking[0].path).toBe('Asset.sha256');
    expect(diff.additive).toEqual([]);
  });

  it('classifies a field that became OPTIONAL as compatible, not breaking', () => {
    // Loosening a requirement is a relaxation: a payload that validated
    // before still validates, so it must NOT require a MAJOR bump.
    const optionalBase: ContractManifest = {
      ...base,
      entities: {
        Asset: {
          fields: {
            id: { required: true, type: 'uuid' },
            sha256: { required: true, type: 'string' },
          },
        },
      },
    };
    const current: ContractManifest = {
      ...optionalBase,
      entities: {
        Asset: {
          fields: {
            id: { required: true, type: 'uuid' },
            sha256: { required: false, type: 'string' },
          },
        },
      },
    };

    const diff = diffManifests(optionalBase, current);

    expect(diff.breaking).toEqual([]);
    expect(diff.additive).toContain('Asset.sha256 became optional');

    const check = checkVersionBump(optionalBase, current);
    expect(check.ok).toBe(true);
    expect(check.requiredMajorBump).toBe(false);
  });

  it('classifies a removed entity, a changed type and a removed enum value as breaking', () => {
    const multiBase: ContractManifest = {
      contractsVersion: '1.0.0',
      entities: {
        Asset: {
          fields: {
            id: { required: true, type: 'uuid' },
            sha256: { required: true, type: 'string' },
          },
        },
        Legacy: { fields: { id: { required: true, type: 'uuid' } } },
      },
      enums: { JobState: ['queued', 'running'] },
    };
    const multiCurrent: ContractManifest = {
      contractsVersion: '1.0.0',
      entities: {
        Asset: {
          fields: {
            id: { required: true, type: 'string' },
            sha256: { required: false, type: 'string' },
          },
        },
      },
      enums: { JobState: ['queued'] },
    };

    const diff = diffManifests(multiBase, multiCurrent);
    const kinds = diff.breaking.map((change) => change.kind);

    expect(kinds).toContain('entity-removed');
    expect(kinds).toContain('field-type-changed');
    expect(kinds).toContain('enum-value-removed');
    expect(diff.breaking.map((change) => change.path)).toContain('Legacy');
    // The demotion of sha256 is a relaxation, so it is additive, not breaking.
    expect(kinds).not.toContain('field-became-required');
    expect(diff.additive).toContain('Asset.sha256 became optional');
  });

  it('classifies a tightened validation constraint as breaking', () => {
    const constrainedBase: ContractManifest = {
      ...base,
      entities: {
        Asset: {
          fields: {
            id: { required: true, type: 'uuid' },
            sha256: {
              required: false,
              type: 'string',
              constraint: 'pattern=^[0-9a-f]{64}$',
            },
          },
        },
      },
    };
    const tightened: ContractManifest = {
      ...constrainedBase,
      entities: {
        Asset: {
          fields: {
            id: { required: true, type: 'uuid' },
            sha256: {
              required: false,
              type: 'string',
              constraint: 'pattern=^[0-9a-f]{32}$',
            },
          },
        },
      },
    };

    const diff = diffManifests(constrainedBase, tightened);

    expect(diff.breaking).toHaveLength(1);
    expect(diff.breaking[0].kind).toBe('field-constraint-changed');
    expect(diff.breaking[0].path).toBe('Asset.sha256');
    expect(diff.additive).toEqual([]);
  });

  it('requires a MAJOR bump for a breaking change and accepts a MINOR one for an additive change', () => {
    const breaking: ContractManifest = {
      ...base,
      entities: { Asset: { fields: { id: { required: true, type: 'uuid' } } } },
    };

    const unchanged = checkVersionBump(base, { ...breaking, contractsVersion: '1.0.0' });
    expect(unchanged.ok).toBe(false);
    expect(unchanged.requiredMajorBump).toBe(true);
    expect(unchanged.reason).toContain('MAJOR');

    const bumped = checkVersionBump(base, { ...breaking, contractsVersion: '2.0.0' });
    expect(bumped.ok).toBe(true);
    expect(bumped.requiredMajorBump).toBe(true);

    const additive = checkVersionBump(base, {
      ...base,
      contractsVersion: '1.1.0',
      entities: {
        Asset: {
          fields: { ...base.entities.Asset.fields, path: { required: false, type: 'string' } },
        },
      },
    });
    expect(additive.ok).toBe(true);
    expect(additive.requiredMajorBump).toBe(false);
    expect(additive.breaking).toEqual([]);
  });

  it('refuses a version downgrade', () => {
    const check = checkVersionBump(
      { ...base, contractsVersion: '2.0.0' },
      {
        ...base,
        contractsVersion: '1.0.0',
      },
    );

    expect(check.ok).toBe(false);
    expect(check.reason).toContain('went down');
  });

  it('extracts the major version of a semver string', () => {
    expect(majorVersion('1.0.0')).toBe(1);
    expect(majorVersion('2.3.4')).toBe(2);
    expect(() => majorVersion('not-a-version')).toThrow();
  });
});
