# Gold split manifests — spec 003, US2

A split manifest is the reproduction record of every metric computed on it
(constitution I). Consumers MUST refuse any image set whose hashes diverge
from the manifest.

| file | dataset | status |
| --- | --- | --- |
| `synthetic-30.gold.json` | `synthetic-fixture` (SYNTHETIC, CI-scale) | committed |
| `visa-subset.gold.json` | `visa-subset` (real VisA subset) | committed — **700 assignments**, 8 strata, `manifestHash 76dee597ea8d42bdba657f37c357cdfc4afc3d3e1de617d90ced7b77e485a0b2` |

## Schema

```ts
interface SplitManifest {
  schemaVersion: 1;
  id: string;                 // 'synthetic-30.gold'
  datasetId: string;          // 'synthetic-fixture' | 'visa-subset'
  seed: number;               // 42
  ratios: { train: number; val: number; test: number };  // 0.6 / 0.2 / 0.2
  strata: Array<{ class: string; anomaly: 'normal' | 'anomalous'; total: number; train: number; val: number; test: number }>;
  assignments: Array<{ id: string; class: string; anomaly: 'normal' | 'anomalous'; split: 'train' | 'val' | 'test'; sha256: string; path: string }>;
  notes: Array<{ id: string; reason: string }>;
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
  from `@vision-lens/contracts`) of the manifest without the hash field.

## Pinned conventions

| convention | value |
| --- | --- |
| PRNG | mulberry32 (32-bit state), seeded per stratum from `seed` XOR FNV-1a of the stratum key — never `Math.random` |
| sort key | item `id`, UTF-16 code-unit order; items are sorted before the shuffle |
| quota rounding | largest remainder over integer weights (ratios ×1000); ties → train > val > test |
| capture grouping | a capture group is assigned **wholly** to one split; if it fits no quota it still goes wholly to the split with the most remaining quota (recorded as a `capture-group-overflow:` note) |
| capture-group fallback | when the annotation CSV carries **no** `session` column, the capture group of an item is its **object class** (`make-splits.ts`, `enumerateSubset`). The upstream VisA release has no session column, so this is the path the real run takes. |
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

## The real VisA manifest

`visa-subset.gold.json` is **committed** and describes **700** real VisA images.

```bash
pnpm exec tsx scripts/benchmarks/make-splits.ts \
  --dataset visa-subset \
  --root datasets/visa-subset \
  --seed 42 \
  --target-images 700 \
  --out benchmarks/splits/visa-subset.gold.json
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

### The split is 100 % `train`

The upstream VisA release carries **no session information**, so every item of a
class lands in one capture group. A 100-item group fits no 60/20/20 quota, so the
generator assigns the whole group to `train` and records a `capture-group-overflow:`
note.

The manifest therefore holds **8** such notes (one per class and anomaly kind) and
**every one of its 700 assignments is `split: "train"`** — `val` and `test` are
empty. **The benchmark scores all 700 gold items; there is no held-out test set.**
This is recorded in the manifest's notes rather than hidden, and the upstream
release does not carry the session data that would make a real split possible.
