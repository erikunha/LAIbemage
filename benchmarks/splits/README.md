# Gold split manifests — spec 003, US2

A split manifest is the reproduction record of every metric computed on it
(constitution I). Consumers MUST refuse any image set whose hashes diverge
from the manifest.

| file | dataset | status |
| --- | --- | --- |
| `synthetic-30.gold.json` | `synthetic-fixture` (SYNTHETIC, CI-scale) | committed |
| `visa-subset.gold.json` | `visa-subset` (real VisA subset) | committed, **frozen**: 700 assignments, 8 strata, `manifestHash 76dee597ea8d42bdba657f37c357cdfc4afc3d3e1de617d90ced7b77e485a0b2`. This is the **v1** split, and all 700 assignments are `train` (the evidence of the degenerate split, VLN-007). It is never rewritten. |
| `visa-subset.v2.gold.json` | `visa-subset` (real VisA subset) | committed: 700 assignments, 8 strata, strategy `stratified`, `manifestHash 503c568463739a1522d675a474a219aecc918553315e0ec4e2800c2b10b21bb5`, `partitionFingerprint 4ac0940380d0283a4ac52bda0884449bc8778ea2605b27c7ef2f26f666b9c963`. **420 train / 140 val / 140 test**, stratified by class and anomaly. This is the tracked split of the suite `visa-subset.v2`. |

## Schema

```ts
interface SplitManifest {
  schemaVersion: 1 | 2;         // 2 = the format that names the strategy
  id: string;                 // 'synthetic-30.gold'
  datasetId: string;          // 'synthetic-fixture' | 'visa-subset'
  seed: number;               // 42
  ratios: { train: number; val: number; test: number };  // 0.6 / 0.2 / 0.2
  strata: Array<{ class: string; anomaly: 'normal' | 'anomalous'; total: number; train: number; val: number; test: number }>;
  assignments: Array<{ id: string; class: string; anomaly: 'normal' | 'anomalous'; split: 'train' | 'val' | 'test'; sha256: string; path: string }>;
  notes: Array<{ id: string; reason: string }>;
  strategy?: 'grouped' | 'stratified';        // schemaVersion 2 and later
  partitionFingerprint?: string;             // schemaVersion 2 and later
  groupBasis?: {                              // schemaVersion 2 and later
    captureGroupsEnforced: boolean;
    oversizedCaptureGroupCount: number;
    statement: string;
  };
  manifestHash: string;       // sha256 over the canonical JSON WITHOUT this field
}
```

* **No timestamp** — a `generatedAt` field would break the byte-identical
  regeneration SC-001 demands. Put the generation date in a sidecar file.
* `notes[]` carries two kinds of record: a note whose `id` matches an
  assignment id marks a **known-bad** item (excluded from the assignments,
  therefore never scored — list it in the report caveats); a note whose `id`
  matches no item is **structural** (e.g. `capture-group-overflow:`).
* `manifestHash` = sha256 (hex) over the canonical JSON (recursive key sort,
  from `@vision-lens/contracts`) of the manifest without the hash field. A
  version 1 manifest does not carry `strategy`, `partitionFingerprint` or
  `groupBasis`, and those fields are left out of the hashed payload, so the
  frozen `visa-subset.gold.json` keeps verifying against the hash it was
  recorded with.
* `partitionFingerprint` = sha256 (hex) over the canonical JSON of the sorted
  `id -> split` pairs. It identifies the **partition** alone, so a benchmark
  number can be attributed to the partition it was measured on.
* `manifestHash` is the identity the reproduction tuple and the baseline
  entries carry in their `splitFingerprint` field. The two names are not the
  same thing: the manifest hash identifies the split **file**, the partition
  fingerprint identifies the **partition**. The gate compares both: a run
  measured against a split that is no longer the tracked one must not be
  published, and neither must a baseline that cannot be attributed to a split.

## Pinned conventions

| convention | value |
| --- | --- |
| PRNG | mulberry32 (32-bit state), seeded per stratum from `seed` XOR FNV-1a of the stratum key — never `Math.random` |
| sort key | item `id`, UTF-16 code-unit order; items are sorted before the shuffle |
| quota rounding | largest remainder over integer weights (ratios ×1000); ties → train > val > test |
| capture grouping | a capture group is assigned **wholly** to one split; if it fits no quota it still goes wholly to the split with the most remaining quota (recorded as a `capture-group-overflow:` note) |
| capture-group fallback | when the annotation CSV carries **no** `session` column, the capture group of an item is its **object class** (`make-splits.ts`, `enumerateSubset`). The upstream VisA release has no session column, so this is the path the real run takes. |
| strategy | `--strategy grouped` (the default): the capture group is the atom of the assignment. `--strategy stratified`: the partition is **item-level**, the capture groups are not enforced, and the items are dealt to the three splits inside every stratum (class x anomaly) in that stratum's own quota. |
| near-duplicates | stub hook only — `nearDuplicateGroups` provider; the embedding-based guard arrives in specs 004/005 |

## Regenerating

```bash
pnpm exec tsx scripts/benchmarks/make-splits.ts \
  --dataset synthetic-fixture \
  --root benchmarks/fixtures/synthetic-fixture \
  --seed 42 --id synthetic-30.gold \
  --out benchmarks/splits/synthetic-30.gold.json
```

The real VisA manifest is produced the same way, with one extra flag — see
"The real VisA manifest" below.

## The real VisA manifests

`visa-subset.gold.json` is **committed** and describes **700** real VisA images. It
is the **v1** split and it is **frozen**: it is the evidence of the defect that
VLN-007 fixes, so it is never rewritten.

```bash
pnpm exec tsx scripts/benchmarks/make-splits.ts \
  --dataset visa-subset \
  --root datasets/visa-subset \
  --seed 42 \
  --target-images 700 \
  --out benchmarks/splits/visa-subset.gold.json
```

`visa-subset.v2.gold.json` is the **v2** split, the tracked split of the suite
`visa-subset.v2`. It is the same 700 images in a real 60/20/20 partition.

```bash
pnpm exec tsx scripts/benchmarks/make-splits.ts \
  --dataset visa-subset \
  --root datasets/visa-subset \
  --seed 42 \
  --target-images 700 \
  --strategy stratified \
  --id visa-subset.v2.gold \
  --out benchmarks/splits/visa-subset.v2.gold.json
```

**`--target-images 700` is not optional here.** The flag makes the generator
select the *same* images the normaliser selects for the same tree — the selection
is shared code (`collectVisaPartData` + `selectVisaSubsetImages` in
`packages/core/src/benchmark/normalize.ts`). Without it the generator splits
**every** row of every `image_anno.csv` (3506 upstream rows), which is a different
set from the 700 the store holds. With it, the manifest and the store describe
one subset: 700 assignments against 700 samples, with identical paths and
identical sha256 digests.

Regeneration is **byte-identical** — the manifest carries no timestamp.

### The v1 split is 100 % `train`

The upstream VisA release carries **no session information**, so every item of a
class lands in one capture group. A 100-item group fits no 60/20/20 quota, so the
generator assigns the whole group to `train` and records a `capture-group-overflow:`
note.

The v1 manifest therefore holds **8** such notes (one per class and anomaly kind)
and **every one of its 700 assignments is `split: "train"`**: `val` and `test` are
empty. **The benchmark scores all 700 gold items; there is no held-out test set.**
This is recorded in the manifest's notes rather than hidden, and the upstream
release does not carry the session data that would make a real split possible.

### The v2 split is item-level and stratified

The `--strategy stratified` run keeps the same 700 images and the same seed and
produces a real partition: **420 train / 140 val / 140 test**, with every class
at 105/35/35 and both anomaly kinds at the expected proportion.

It does so by giving up the capture-group property, and the manifest says so in
two places that a reader cannot miss:

* `groupBasis.captureGroupsEnforced` is `false`, `groupBasis.oversizedCaptureGroupCount`
  is `4` (one per class: each class group is larger than every quota), and
  `groupBasis.statement` states in plain words that the partition is item-level
  and **not** capture-group-safe;
* a `notes[]` entry (`strategy:item-level`) repeats it.

An item-level partition cannot prove acquisition-level independence. It is the
honest option for a release that carries no session column: it gives a held-out
set and it states what it cannot guarantee.
