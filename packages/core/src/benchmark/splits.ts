/**
 * Seeded, stratified gold split generator — spec 003, US2 (FR-003, SC-001).
 *
 * WHY this module exists: every metric Vision Lens reports must name the
 * split it was computed on (constitution I — "a metric without its
 * reproduction record is a hypothesis"). A split that cannot be regenerated
 * byte-for-byte makes the metric unfalsifiable, so every convention below is
 * pinned and documented rather than left to the platform.
 *
 * Pinned conventions
 * ------------------
 * PRNG ............ mulberry32 (Tommy Ettinger), 32-bit state. Only
 *                    `Math.imul` and `>>>` are used — both exactly defined by
 *                    ECMA-262 — so the stream is bit-identical on every Node
 *                    version and every machine. `Math.random` is NEVER used:
 *                    it is unseeded and would break SC-001 byte-stability.
 * Sort key ......... item `id`, compared in UTF-16 code-unit order (NOT
 *                    locale collation, which differs between machines).
 *                    Items are sorted BEFORE the shuffle and every output
 *                    array is sorted by the same key, so the caller may pass
 *                    items in any order and get the same manifest.
 * Ratios .......... 0.6 / 0.2 / 0.2 by default, converted to INTEGER weights
 *                    (×1000) before the quota arithmetic. `total * 0.6` in
 *                    binary floating point can land one ULP below an integer
 *                    (e.g. 15 * 0.6 === 8.999999999999998), which would
 *                    silently move an item between splits; integer weights
 *                    make the quota exact and platform-independent.
 * Rounding rule ... largest remainder: floor every quota, then hand the
 *                    leftover items to the splits with the largest fractional
 *                    part, ties broken in the fixed order train > val > test.
 *                    A stratum smaller than five items therefore cannot fill
 *                    all three splits (1 item → train 1 / val 0 / test 0;
 *                    2 items → train 1 / val 1 / test 0). The counts that were
 *                    actually used are recorded per stratum in `strata[]`, so
 *                    a reader always sees exactly what happened.
 * Capture grouping  items that share a capture group (a VisA part-session)
 *                    are never split across train/val/test: the group is the
 *                    atom of the assignment and is placed wholly in one
 *                    split. This is the leakage-aware unit named by
 *                    specs/003/research/visa-dataset.md — the same part's
 *                    captures must not straddle train and test.
 *                    EXCEPTION: when a group is larger than the remaining
 *                    quota of every split, it is STILL assigned wholly (never
 *                    divided) — to the split with the most remaining quota.
 *                    That split then exceeds its nominal quota; the
 *                    deviation shows up in `strata[]` and is recorded as a
 *                    `notes[]` entry prefixed `capture-group-overflow:`.
 * Strategies ....... two strategies, named in the manifest, the CLI flag and
 *                    this module:
 *                    - `grouped` (the default): capture groups are the atom
 *                      of the assignment, as described above. This is the
 *                      behaviour of every split generated before VLN-007.
 *                    - `stratified`: the capture-group property is NOT
 *                      enforced. The partition is ITEM-LEVEL and stratified:
 *                      within every stratum (class x anomaly) the items are
 *                      shuffled with the stratum PRNG and dealt to the three
 *                      splits in the stratum's own quota, so each split
 *                      carries every class and both anomaly labels in the
 *                      expected proportion.
 *                      The manifest says so, in `groupBasis` and in a
 *                      `notes[]` entry: a reader must never mistake an
 *                      item-level partition for a group-safe one.
 *                      This strategy exists because a group that is larger
 *                      than every quota CANNOT be kept whole in three
 *                      partitions — the upstream VisA release carries no
 *                      session column, so the capture group of an item is
 *                      its object class, and the `grouped` strategy then
 *                      degenerates to an all-train split (VLN-007).
 * Partition hash ..  `partitionFingerprint` = sha256 over the canonical JSON
 *                    of the sorted `id -> split` pairs. It identifies the
 *                    PARTITION (which item sits in which split) independently
 *                    of the manifest's other content. It is NOT the identity
 *                    of the split FILE: that is `manifestHash` (see below).
 *                    The benchmark gate compares FILE identities, so the
 *                    reproduction tuple and the baseline entries carry the
 *                    `manifestHash` under the name `splitFingerprint`.
 * Notes channel ... `notes[]` carries two kinds of record:
 *                      - a note whose `id` matches an item id marks that item
 *                        as KNOWN-BAD: it is excluded from the assignments
 *                        (it never enters a split and is never scored) and is
 *                        listed by the consumer in the report caveats.
 *                      - a note whose `id` does not match any item is a
 *                        structural record (e.g. `capture-group-overflow:`).
 *                    Both kinds are part of the hashed manifest.
 * Hash ............ `manifestHash` = sha256 (hex) over the canonical JSON
 *                    (recursive key sort, from @vision-lens/contracts) of
 *                    the manifest WITHOUT the `manifestHash` field. The
 *                    canonical JSON is the contracts' own serialiser — never
 *                    re-implemented here — so this hash agrees with every
 *                    other fingerprint in the platform.
 *                    It is the identity of the split FILE: the reproduction
 *                    tuple and the baseline entries carry it under the name
 *                    `splitFingerprint`, because it names the file a number
 *                    was measured against.
 * No timestamps ... the manifest carries NO generation timestamp: a
 *                    timestamp would change the bytes on every run and break
 *                    SC-001 byte-stability. Record the generation date in a
 *                    sidecar file if it is needed.
 * Near-duplicates . STUB HOOK ONLY. `nearDuplicateGroups` accepts a provider
 *                    that maps item ids to a group key; those groups are
 *                    merged with the capture groups (union-find) so that
 *                    near-duplicate images can never straddle a split. The
 *                    real embedding-based provider arrives in specs 004/005;
 *                    no embedding is computed here.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson } from '@vision-lens/contracts';

/**
 * Schema version of the split manifest. Bump on any breaking field change.
 *
 * Version 2 adds `strategy`, `partitionFingerprint` and `groupBasis`. A version 1
 * manifest (the frozen `visa-subset.gold.json`, which is the EVIDENCE of the
 * degenerate all-train split and is never rewritten) stays valid: the hash
 * payload drops the fields a manifest does not carry, so its recorded
 * `manifestHash` still verifies.
 */
export const SPLIT_MANIFEST_SCHEMA_VERSION = 2;

/** The schema version of the first (pre-strategy) manifest format. */
export const LEGACY_SPLIT_MANIFEST_SCHEMA_VERSION = 1;

export type SplitName = 'train' | 'val' | 'test';

/**
 * The two strategies the engine can produce.
 *
 * - `grouped`  the capture group is the atom of the assignment (the legacy
 *              behaviour, unchanged);
 * - `stratified` the partition is ITEM-LEVEL: the capture groups are not
 *              enforced, and the split is stratified by class and anomaly
 *              instead.
 */
export type SplitStrategy = 'grouped' | 'stratified';

/** Every supported strategy, in the order the CLI lists them. */
export const SPLIT_STRATEGIES: readonly SplitStrategy[] = ['grouped', 'stratified'];

/**
 * The strategy a generator uses when the caller names none.
 *
 * `grouped` — the behaviour every pre-VLN-007 split was produced with. A
 * caller that names no strategy gets exactly the legacy partition.
 */
export const DEFAULT_SPLIT_STRATEGY: SplitStrategy = 'grouped';

export type AnomalyLabel = 'normal' | 'anomalous';

/** Fixed split order — also the tie-break order of every quota decision. */
export const SPLIT_NAMES: readonly SplitName[] = ['train', 'val', 'test'];

export interface SplitRatios {
  train: number;
  val: number;
  test: number;
}

/** The 60/20/20 split pinned by spec 003 US2. */
export const DEFAULT_SPLIT_RATIOS: SplitRatios = { train: 0.6, val: 0.2, test: 0.2 };

/** Reason prefix used for the structural "group did not fit" note. */
export const CAPTURE_GROUP_OVERFLOW_REASON_PREFIX = 'capture-group-overflow:';

/** Reason prefix used when a caller documents a known-bad gold label. */
export const KNOWN_BAD_REASON_PREFIX = 'known-bad:';

/**
 * The id of the note that states what the item-level partition is.
 *
 * It is not an item id, so the note is a structural record (the notes channel
 * treats a note whose id matches an item id as a known-bad item).
 */
export const STRATEGY_NOTE_ID = 'strategy:item-level';

/** One image to be split. */
export interface SplitItem {
  /** Stable unique id — also the sort key of every deterministic ordering. */
  id: string;
  /** Class label (VisA part name for the real dataset). */
  class: string;
  /** Anomaly label. */
  anomaly: AnomalyLabel;
  /**
   * Capture/session grouping key. Items sharing it are assigned to the SAME
   * split (leakage-aware unit). Omit for items that have no session.
   */
  group?: string;
  /** sha256 of the image file (hex). */
  sha256: string;
  /** Path of the image, relative to the dataset root (posix separators). */
  path: string;
}

export interface SplitStratum {
  class: string;
  anomaly: AnomalyLabel;
  total: number;
  train: number;
  val: number;
  test: number;
}

export interface SplitAssignment {
  id: string;
  class: string;
  anomaly: AnomalyLabel;
  split: SplitName;
  sha256: string;
  path: string;
}

export interface SplitNote {
  id: string;
  reason: string;
}

/**
 * What the partition is (and is not) with respect to the capture groups.
 *
 * The field exists so that a reader of a manifest can never mistake an
 * item-level partition for a capture-group-safe one: the upstream VisA release
 * carries no session column, so the capture group of an item IS its object
 * class, and a class that is larger than every quota cannot be kept whole in
 * three partitions (VLN-007).
 */
export interface SplitGroupBasis {
  /** Whether the capture-group property was enforced by the partition. */
  readonly captureGroupsEnforced: boolean;
  /**
   * The number of DISTINCT capture groups that were too large to be kept
   * whole inside at least one stratum. A group that spans two strata (the
   * same class, both anomaly kinds) is counted once.
   */
  readonly oversizedCaptureGroupCount: number;
  /** The plain-language statement of what the partition is. */
  readonly statement: string;
}

export interface SplitManifest {
  /** 1 = the pre-strategy format; 2 = the format that names the strategy. */
  schemaVersion: 1 | 2;
  id: string;
  datasetId: string;
  seed: number;
  ratios: SplitRatios;
  strata: SplitStratum[];
  assignments: SplitAssignment[];
  notes: SplitNote[];
  /** The strategy that produced the partition (schemaVersion 2 and later). */
  strategy?: SplitStrategy;
  /**
   * The fingerprint of the PARTITION (which item sits in which split),
   * independently of the rest of the manifest (schemaVersion 2 and later).
   *
   * It is NOT the identity of the split file: that is `manifestHash`. The
   * name is deliberately different from the `splitFingerprint` of the
   * reproduction tuple and of a baseline entry, which carries the
   * `manifestHash` because it names the FILE a number was measured against.
   */
  partitionFingerprint?: string;
  /** What the partition is with respect to the capture groups (schemaVersion 2 and later). */
  groupBasis?: SplitGroupBasis;
  manifestHash: string;
}

export type SplitManifestWithoutHash = Omit<SplitManifest, 'manifestHash'>;

/**
 * STUB HOOK (specs 004/005 own the real implementation).
 *
 * A provider maps item ids to a near-duplicate group key. Items sharing a
 * key are kept in the same split. The provider is expected to come from an
 * embedding-based near-duplicate detector; this module never computes
 * embeddings itself.
 */
export type NearDuplicateGroupProvider = (
  items: readonly SplitItem[],
) => ReadonlyMap<string, string>;

export interface GenerateSplitOptions {
  /** Manifest id, e.g. `synthetic-30.gold`. */
  id: string;
  /** Dataset id, e.g. `synthetic-fixture` or `visa-subset`. */
  datasetId: string;
  /** Seed of the split — recorded in the manifest (constitution I). */
  seed: number;
  /** Items to split. Order does not matter (items are sorted first). */
  items: readonly SplitItem[];
  /** Known-bad items / structural notes. */
  notes?: readonly SplitNote[];
  /** Train/val/test ratios. Defaults to 60/20/20. */
  ratios?: SplitRatios;
  /**
   * The strategy that produces the partition. Defaults to `grouped`, the
   * behaviour every pre-VLN-007 split was produced with.
   */
  strategy?: SplitStrategy;
  /** Optional near-duplicate grouping provider (stub hook). */
  nearDuplicateGroups?: NearDuplicateGroupProvider;
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

/** UTF-16 code-unit comparison — locale-independent, machine-independent. */
export function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * mulberry32 — 32-bit state PRNG (Tommy Ettinger).
 *
 * WHY pinned: the generator must be reproducible across Node versions and
 * machines (constitution I). mulberry32 uses only `Math.imul` and `>>>`,
 * whose semantics are fully specified by ECMA-262, so the stream is
 * bit-identical everywhere. `Math.random` is deliberately absent.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a (32-bit) — used to derive a per-stratum seed from the run seed. */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Per-stratum seed: `seed` XOR the FNV-1a hash of the stratum key.
 *
 * WHY: the seed of one stratum must not depend on how many strata the
 * dataset has, otherwise adding a class would reshuffle every other class.
 */
export function stratumSeed(seed: number, className: string, anomaly: AnomalyLabel): number {
  return (seed ^ fnv1a32(`${className}\u0000${anomaly}`)) >>> 0;
}

/** sha256 (hex) of a buffer or string. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Fisher-Yates shuffle driven by the supplied PRNG (descending index form). */
function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Quotas
 * ------------------------------------------------------------------ */

/**
 * Per-split quotas for a stratum of `total` items — the pinned rounding rule.
 *
 * Largest remainder over integer weights:
 *   1. floor every quota (`total * weight / weightSum`, integer arithmetic),
 *   2. hand the leftover items to the splits with the largest fractional
 *      part, ties broken in the fixed order train > val > test.
 *
 * Small strata therefore cannot fill all three splits; the counts actually
 * used are recorded in `strata[]`.
 */
export function computeSplitCapacities(
  total: number,
  ratios: SplitRatios = DEFAULT_SPLIT_RATIOS,
): Record<SplitName, number> {
  const weights: Record<SplitName, number> = {
    train: Math.round(ratios.train * 1000),
    val: Math.round(ratios.val * 1000),
    test: Math.round(ratios.test * 1000),
  };
  const weightSum = weights.train + weights.val + weights.test;

  const counts: Record<SplitName, number> = { train: 0, val: 0, test: 0 };
  const remainders: Array<{ split: SplitName; remainder: number }> = [];
  let assigned = 0;

  for (const split of SPLIT_NAMES) {
    const numerator = total * weights[split];
    counts[split] = Math.floor(numerator / weightSum);
    remainders.push({ split, remainder: numerator % weightSum });
    assigned += counts[split];
  }

  let leftover = total - assigned;
  const ordered = remainders
    .slice()
    .sort(
      (a, b) =>
        b.remainder - a.remainder || SPLIT_NAMES.indexOf(a.split) - SPLIT_NAMES.indexOf(b.split),
    );
  let cursor = 0;
  while (leftover > 0 && cursor < ordered.length) {
    counts[ordered[cursor].split] += 1;
    leftover -= 1;
    cursor += 1;
  }
  // Defensive: ratios that do not sum to 1 leave items over — hand them out
  // in the fixed split order so nothing is ever dropped.
  cursor = 0;
  while (leftover > 0) {
    counts[SPLIT_NAMES[cursor % SPLIT_NAMES.length]] += 1;
    leftover -= 1;
    cursor += 1;
  }

  return counts;
}

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_unused, index) => index);
  }

  find(node: number): number {
    let root = node;
    while (this.parent[root] !== root) root = this.parent[root];
    // path compression
    let cursor = node;
    while (this.parent[cursor] !== root) {
      const next = this.parent[cursor];
      this.parent[cursor] = root;
      cursor = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    // Keep the smaller index as the root so the structure is deterministic.
    const [keep, drop] = a < b ? [a, b] : [b, a];
    this.parent[drop] = keep;
  }
}

interface StratumGroup {
  /**
   * Human-readable identity of the group: the capture-group key when every
   * item of the group shares one, otherwise the smallest item id (which is
   * the case when near-duplicate groups merged several capture groups).
   */
  key: string;
  /** Smallest item id of the group — the deterministic sort key. */
  minItemId: string;
  items: SplitItem[];
}

/**
 * Build the capture groups of one stratum.
 *
 * Capture groups and near-duplicate groups are merged with a union-find, so
 * the transitive closure is honoured: if two items of one part are
 * near-duplicates of two items of another part, all four stay together.
 */
function buildGroups(
  items: readonly SplitItem[],
  nearDuplicateGroups?: NearDuplicateGroupProvider,
): StratumGroup[] {
  const unionFind = new UnionFind(items.length);
  const indexById = new Map<string, number>();
  items.forEach((item, index) => indexById.set(item.id, index));

  const firstOfGroupKey = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item.group === undefined || item.group === '') continue;
    const seen = firstOfGroupKey.get(item.group);
    if (seen === undefined) {
      firstOfGroupKey.set(item.group, index);
    } else {
      unionFind.union(seen, index);
    }
  }

  if (nearDuplicateGroups) {
    const duplicates = nearDuplicateGroups(items);
    const firstOfDuplicateKey = new Map<string, number>();
    for (const item of items) {
      const duplicateKey = duplicates.get(item.id);
      if (duplicateKey === undefined || duplicateKey === '') continue;
      const seen = firstOfDuplicateKey.get(duplicateKey);
      if (seen === undefined) {
        firstOfDuplicateKey.set(duplicateKey, indexById.get(item.id) ?? -1);
      } else if (seen >= 0) {
        unionFind.union(seen, indexById.get(item.id) ?? seen);
      }
    }
  }

  const byRoot = new Map<number, SplitItem[]>();
  items.forEach((item, index) => {
    const root = unionFind.find(index);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(item);
    else byRoot.set(root, [item]);
  });

  const groups: StratumGroup[] = [];
  for (const bucket of byRoot.values()) {
    const sorted = bucket.slice().sort((a, b) => compareIds(a.id, b.id));
    // The capture-group key is the readable identity of the group; when the
    // group merged several capture groups (near-duplicate hook) there is no
    // single key and the smallest item id is used instead.
    const captureKeys = new Set(
      sorted.map((item) => item.group).filter((group): group is string => Boolean(group)),
    );
    const key = captureKeys.size === 1 ? [...captureKeys][0] : sorted[0].id;
    groups.push({ key, minItemId: sorted[0].id, items: sorted });
  }
  groups.sort((a, b) => compareIds(a.minItemId, b.minItemId));
  return groups;
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */

interface StratumPlacement {
  splitByItemId: Map<string, SplitName>;
  overflows: Array<{ group: StratumGroup; split: SplitName; remainingBefore: number }>;
}

/**
 * Place the capture groups of one stratum into the three splits.
 *
 * Groups are shuffled with the stratum PRNG and then ordered by size
 * (descending). Each group goes to the split with the LARGEST remaining
 * quota among those that can still hold it whole; ties are broken in the
 * fixed order train > val > test. A group that fits nowhere is assigned
 * wholly (never divided) to the split with the most remaining quota — the
 * documented overflow exception.
 */
function placeGroups(
  groups: readonly StratumGroup[],
  capacities: Record<SplitName, number>,
  rand: () => number,
): StratumPlacement {
  const remaining: Record<SplitName, number> = { ...capacities };
  const splitByItemId = new Map<string, SplitName>();
  const overflows: StratumPlacement['overflows'] = [];

  const ordered = shuffle(groups, rand).sort((a, b) => b.items.length - a.items.length);

  for (const group of ordered) {
    const size = group.items.length;

    let target: SplitName | undefined;
    for (const split of SPLIT_NAMES) {
      if (remaining[split] < size) continue;
      if (target === undefined || remaining[split] > remaining[target]) target = split;
    }

    if (target === undefined) {
      // Overflow: the group is bigger than the remaining quota of every
      // split. It is still assigned wholly, to the split with the most
      // remaining quota (ties → fixed order).
      let fallback: SplitName = SPLIT_NAMES[0];
      for (const split of SPLIT_NAMES) {
        if (remaining[split] > remaining[fallback]) fallback = split;
      }
      overflows.push({ group, split: fallback, remainingBefore: remaining[fallback] });
      remaining[fallback] -= size;
      for (const item of group.items) splitByItemId.set(item.id, fallback);
      continue;
    }

    remaining[target] -= size;
    for (const item of group.items) splitByItemId.set(item.id, target);
  }

  return { splitByItemId, overflows };
}

/**
 * Deal the items of one stratum to the three splits. This is the ITEM-LEVEL
 * strategy.
 *
 * The items are shuffled with the stratum PRNG and then dealt out in the
 * fixed split order: the first `capacities.train` items go to `train`, the
 * next `capacities.val` to `val` and the rest to `test`. Every item therefore
 * lands in the stratum's own quota, so the partition carries every class and
 * both anomaly labels in the expected proportion.
 *
 * The capture groups are NOT consulted: this is the strategy that exists
 * precisely because a group larger than every quota cannot be kept whole.
 */
function placeItems(
  items: readonly SplitItem[],
  capacities: Record<SplitName, number>,
  rand: () => number,
): StratumPlacement {
  const splitByItemId = new Map<string, SplitName>();
  const ordered = shuffle(items, rand);

  let cursor = 0;
  for (const split of SPLIT_NAMES) {
    for (let index = 0; index < capacities[split]; index += 1) {
      const item = ordered[cursor];
      cursor += 1;
      if (item === undefined) break;
      splitByItemId.set(item.id, split);
    }
  }
  // Defensive: a quota that does not cover every item leaves the remainder
  // unassigned: it goes to the last split, so no item is ever dropped.
  for (; cursor < ordered.length; cursor += 1) {
    const item = ordered[cursor];
    if (item === undefined) break;
    splitByItemId.set(item.id, 'test');
  }

  return { splitByItemId, overflows: [] };
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

/**
 * The manifest without its hash field — the exact input of the hash.
 *
 * The fields a manifest does not carry are OMITTED from the payload (not
 * written as `undefined`): a version 1 manifest, the frozen
 * `visa-subset.gold.json`, which is the evidence of the degenerate all-train
 * split and is never rewritten, must keep verifying against the
 * `manifestHash` it was recorded with.
 */
export function manifestWithoutHash(manifest: SplitManifest): SplitManifestWithoutHash {
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    datasetId: manifest.datasetId,
    seed: manifest.seed,
    ratios: manifest.ratios,
    strata: manifest.strata,
    assignments: manifest.assignments,
    notes: manifest.notes,
    ...(manifest.strategy === undefined ? {} : { strategy: manifest.strategy }),
    ...(manifest.partitionFingerprint === undefined
      ? {}
      : { partitionFingerprint: manifest.partitionFingerprint }),
    ...(manifest.groupBasis === undefined ? {} : { groupBasis: manifest.groupBasis }),
  };
}

/**
 * `manifestHash` = sha256 (hex) over the canonical JSON of the manifest
 * WITHOUT the `manifestHash` field.
 */
export function computeManifestHash(manifest: SplitManifest | SplitManifestWithoutHash): string {
  const payload: SplitManifestWithoutHash = {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    datasetId: manifest.datasetId,
    seed: manifest.seed,
    ratios: manifest.ratios,
    strata: manifest.strata,
    assignments: manifest.assignments,
    notes: manifest.notes,
    ...(manifest.strategy === undefined ? {} : { strategy: manifest.strategy }),
    ...(manifest.partitionFingerprint === undefined
      ? {}
      : { partitionFingerprint: manifest.partitionFingerprint }),
    ...(manifest.groupBasis === undefined ? {} : { groupBasis: manifest.groupBasis }),
  };
  return sha256Hex(canonicalJson(payload));
}

/**
 * The fingerprint of the PARTITION: sha256 (hex) over the canonical JSON of
 * the sorted `id -> split` pairs.
 *
 * WHY a second fingerprint: the `manifestHash` covers the WHOLE manifest
 * (the seed, the ratios, the notes, the ids of the images). The partition
 * fingerprint covers the PARTITION alone (which item sits in which split),
 * so two manifests that describe the same partition but differ in their
 * bookkeeping still compare equal.
 *
 * The pairs are sorted by item id (UTF-16 code-unit order, the same sort key
 * as everywhere else in this module), so the fingerprint does not depend on
 * the order of the assignments.
 */
export function computePartitionFingerprint(
  assignments: readonly SplitAssignment[],
): string {
  const pairs = assignments
    .map((assignment) => [assignment.id, assignment.split] as const)
    .sort((left, right) => compareIds(left[0], right[0]));
  return sha256Hex(canonicalJson(pairs));
}

/** Byte-stable serialisation of the manifest (2-space JSON + trailing newline). */
export function serializeSplitManifest(manifest: SplitManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Generate the gold split manifest.
 *
 * Deterministic: the same seed and the same items always produce the same
 * manifest, byte for byte (SC-001), regardless of the order in which the
 * items are supplied.
 *
 * The strategy decides what the ATOM of the assignment is: the capture group
 * (`grouped`, the default) or the single item (`stratified`). The manifest
 * always records which one was used, the fingerprint of the partition and the
 * group basis, the statement of what the partition is (and is not) with
 * respect to the capture groups.
 */
export function generateSplitManifest(options: GenerateSplitOptions): SplitManifest {
  const ratios = options.ratios ?? DEFAULT_SPLIT_RATIOS;
  const strategy = options.strategy ?? DEFAULT_SPLIT_STRATEGY;
  const callerNotes = options.notes ? options.notes.slice() : [];

  // 1. Sort first — the sort key is the item id, so input order is irrelevant.
  const sortedItems = options.items.slice().sort((a, b) => compareIds(a.id, b.id));

  // 2. Known-bad items (a note whose id matches an item id) are excluded
  //    from scoring: they never enter a split.
  const itemIds = new Set(sortedItems.map((item) => item.id));
  const knownBadIds = new Set(
    callerNotes.filter((note) => itemIds.has(note.id)).map((note) => note.id),
  );
  const scoredItems = sortedItems.filter((item) => !knownBadIds.has(item.id));

  // 3. Stratify by class × anomaly.
  const strataMap = new Map<string, { class: string; anomaly: AnomalyLabel; items: SplitItem[] }>();
  for (const item of scoredItems) {
    const key = `${item.class}\u0000${item.anomaly}`;
    const bucket = strataMap.get(key);
    if (bucket) bucket.items.push(item);
    else strataMap.set(key, { class: item.class, anomaly: item.anomaly, items: [item] });
  }
  const strata = [...strataMap.values()].sort(
    (a, b) => compareIds(a.class, b.class) || compareIds(a.anomaly, b.anomaly),
  );

  // 4. Place the items of every stratum, with the atom of the strategy.
  const splitByItemId = new Map<string, SplitName>();
  const overflowNotes: SplitNote[] = [];
  const strataRows: SplitStratum[] = [];
  // The capture groups that were too large to be kept whole in their stratum.
  const oversizedGroups = new Set<string>();

  for (const stratum of strata) {
    const items = stratum.items.slice().sort((a, b) => compareIds(a.id, b.id));
    const capacities = computeSplitCapacities(items.length, ratios);
    const rand = mulberry32(stratumSeed(options.seed, stratum.class, stratum.anomaly));

    // The capture groups of the stratum: always computed, because the group
    // basis of the manifest reports them. The near-duplicate hook is applied
    // to the PLACEMENT of the grouped strategy only: the item-level strategy
    // does not keep groups together at all.
    const captureGroups = buildGroups(items, undefined);
    const largestQuota = Math.max(capacities.train, capacities.val, capacities.test);
    for (const group of captureGroups) {
      if (group.items.length > largestQuota) oversizedGroups.add(group.key);
    }

    if (strategy === 'stratified') {
      const placement = placeItems(items, capacities, rand);
      for (const [itemId, split] of placement.splitByItemId) splitByItemId.set(itemId, split);
    } else {
      const groups = buildGroups(items, options.nearDuplicateGroups);
      const placement = placeGroups(groups, capacities, rand);

      for (const [itemId, split] of placement.splitByItemId) splitByItemId.set(itemId, split);

      for (const overflow of placement.overflows) {
        overflowNotes.push({
          id: `capture-group:${stratum.class}/${stratum.anomaly}/${overflow.group.key}`,
          reason:
            `${CAPTURE_GROUP_OVERFLOW_REASON_PREFIX}${overflow.group.items.length} capture-grouped ` +
            `items could not fit the remaining quota of any split; assigned wholly to '${overflow.split}' ` +
            `(remaining quota before assignment: ${overflow.remainingBefore}).`,
        });
      }
    }

    const counts: Record<SplitName, number> = { train: 0, val: 0, test: 0 };
    for (const item of items) {
      const split = splitByItemId.get(item.id);
      if (split) counts[split] += 1;
    }
    strataRows.push({
      class: stratum.class,
      anomaly: stratum.anomaly,
      total: items.length,
      train: counts.train,
      val: counts.val,
      test: counts.test,
    });
  }

  // 5. Assignments — sorted by id, one entry per scored item.
  const assignments: SplitAssignment[] = scoredItems
    .map((item) => {
      const split = splitByItemId.get(item.id);
      if (!split) {
        throw new Error(`split generator: item '${item.id}' was not assigned to a split`);
      }
      return {
        id: item.id,
        class: item.class,
        anomaly: item.anomaly,
        split,
        sha256: item.sha256,
        path: item.path,
      };
    })
    .sort((a, b) => compareIds(a.id, b.id));

  // 6. Notes: the caller notes, the structural overflow notes and the strategy
  //    note, sorted by id.
  const strategyNotes: SplitNote[] =
    strategy === 'stratified'
      ? [
          {
            id: STRATEGY_NOTE_ID,
            reason:
              'item-level partition: the capture-group property is NOT enforced, so the items of ' +
              'one capture group may sit in different splits. The partition is stratified by ' +
              `class and anomaly instead; ${oversizedGroups.size} capture group(s) were too large ` +
              'to be kept whole.',
          },
        ]
      : [];
  const notes = [...callerNotes, ...overflowNotes, ...strategyNotes].sort((a, b) =>
    compareIds(a.id, b.id),
  );

  // 7. The group basis: what the partition is (and is not) with respect to
  //    the capture groups.
  const groupBasis: SplitGroupBasis =
    strategy === 'stratified'
      ? {
          captureGroupsEnforced: false,
          oversizedCaptureGroupCount: oversizedGroups.size,
          statement:
            'This partition is ITEM-LEVEL: the capture-group property is NOT enforced, so the ' +
            'items of one capture group may sit in different splits. It is stratified by class ' +
            'and anomaly instead, and it cannot prove acquisition-level independence.',
        }
      : {
          captureGroupsEnforced: true,
          oversizedCaptureGroupCount: oversizedGroups.size,
          statement:
            'Capture groups are the atom of the assignment: inside a stratum (class x anomaly) ' +
            'the items of a capture group are never separated. A group larger than every quota ' +
            'is assigned wholly and recorded as a capture-group-overflow note.',
        };

  const manifest: SplitManifestWithoutHash = {
    schemaVersion: SPLIT_MANIFEST_SCHEMA_VERSION,
    id: options.id,
    datasetId: options.datasetId,
    seed: options.seed,
    ratios: { train: ratios.train, val: ratios.val, test: ratios.test },
    strata: strataRows,
    assignments,
    notes,
    strategy,
    partitionFingerprint: computePartitionFingerprint(assignments),
    groupBasis,
  };

  return { ...manifest, manifestHash: computeManifestHash(manifest) };
}

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

export type ManifestDivergenceKind =
  | 'manifest-hash-mismatch'
  | 'image-hash-mismatch'
  | 'missing-file'
  | 'unexpected-item';

export interface ManifestDivergence {
  kind: ManifestDivergenceKind;
  /** Item id (or group id for structural divergences). */
  id: string;
  /** Path of the offending file, relative to the dataset root. */
  path: string;
  /** Hash the manifest claims (or the manifest hash itself). */
  expectedSha256: string;
  /** Hash recomputed from the image / the manifest. */
  actualSha256: string;
  /** Human readable explanation. */
  message: string;
}

export interface ManifestValidationResult {
  ok: boolean;
  divergences: ManifestDivergence[];
}

export interface ValidateSplitManifestOptions {
  /** Dataset root the manifest `path` entries are relative to. */
  root?: string;
  /**
   * Expected sha256 per item id (e.g. freshly computed from the files).
   * Divergences are reported without touching the filesystem.
   */
  expectedHashes?: ReadonlyMap<string, string> | Record<string, string>;
}

/**
 * Validate a manifest against given hashes (pure, no filesystem access).
 *
 * Reports the manifest hash divergence and every item whose hash differs
 * from the expected value, naming the file and both hashes.
 */
export function validateSplitManifestHashes(
  manifest: SplitManifest,
  expectedHashes?: ReadonlyMap<string, string> | Record<string, string>,
): ManifestValidationResult {
  const divergences: ManifestDivergence[] = [];

  const recomputed = computeManifestHash(manifest);
  if (recomputed !== manifest.manifestHash) {
    divergences.push({
      kind: 'manifest-hash-mismatch',
      id: manifest.id,
      path: '',
      expectedSha256: manifest.manifestHash,
      actualSha256: recomputed,
      message:
        `manifest '${manifest.id}' hash mismatch: the manifest claims ${manifest.manifestHash} ` +
        `but its content hashes to ${recomputed}.`,
    });
  }

  if (expectedHashes) {
    const lookup =
      expectedHashes instanceof Map
        ? (id: string): string | undefined => expectedHashes.get(id)
        : (id: string): string | undefined => (expectedHashes as Record<string, string>)[id];
    for (const assignment of manifest.assignments) {
      const expected = lookup(assignment.id);
      if (expected === undefined) continue;
      if (expected !== assignment.sha256) {
        divergences.push({
          kind: 'image-hash-mismatch',
          id: assignment.id,
          path: assignment.path,
          expectedSha256: assignment.sha256,
          actualSha256: expected,
          message:
            `image '${assignment.path}' (id '${assignment.id}') hash mismatch: the manifest pins ` +
            `${assignment.sha256} but the file hashes to ${expected}.`,
        });
      }
    }
  }

  return { ok: divergences.length === 0, divergences };
}

/**
 * Validate a manifest against the images on disk (and/or given hashes).
 *
 * A tampered image (changed bytes → changed sha256) fails validation with
 * the offending file named and both hashes reported.
 */
export async function validateSplitManifest(
  manifest: SplitManifest,
  options: ValidateSplitManifestOptions = {},
): Promise<ManifestValidationResult> {
  const result = validateSplitManifestHashes(manifest, options.expectedHashes);
  const divergences = result.divergences.slice();

  if (options.root) {
    for (const assignment of manifest.assignments) {
      const absolute = path.join(options.root, assignment.path);
      let bytes: Buffer;
      try {
        bytes = await readFile(absolute);
      } catch {
        divergences.push({
          kind: 'missing-file',
          id: assignment.id,
          path: assignment.path,
          expectedSha256: assignment.sha256,
          actualSha256: '',
          message:
            `image '${assignment.path}' (id '${assignment.id}') is missing under the dataset root ` +
            `'${options.root}'; the manifest pins sha256 ${assignment.sha256}.`,
        });
        continue;
      }
      const actual = sha256Hex(bytes);
      if (actual !== assignment.sha256) {
        divergences.push({
          kind: 'image-hash-mismatch',
          id: assignment.id,
          path: assignment.path,
          expectedSha256: assignment.sha256,
          actualSha256: actual,
          message:
            `image '${assignment.path}' (id '${assignment.id}') hash mismatch: the manifest pins ` +
            `${assignment.sha256} but the file on disk hashes to ${actual}.`,
        });
      }
    }
  }

  return { ok: divergences.length === 0, divergences };
}
