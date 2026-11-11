# Gold split manifests — spec 003, US2

A split manifest is the reproduction record of every metric computed on it
(constitution I). Consumers MUST refuse any image set whose hashes diverge
from the manifest.

| file | dataset | status |
| --- | --- | --- |
| `synthetic-30.gold.json` | `synthetic-fixture` (SYNTHETIC, CI-scale) | committed |
| `visa-subset.gold.json` | `visa-subset` (real VisA subset) | **intentionally absent** — the dataset has not been fetched yet |

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
  from `@master-vision/contracts`) of the manifest without the hash field.

## Pinned conventions

| convention | value |
| --- | --- |
| PRNG | mulberry32 (32-bit state), seeded per stratum from `seed` XOR FNV-1a of the stratum key — never `Math.random` |
| sort key | item `id`, UTF-16 code-unit order; items are sorted before the shuffle |
| quota rounding | largest remainder over integer weights (ratios ×1000); ties → train > val > test |
| capture grouping | a capture group is assigned **wholly** to one split; if it fits no quota it still goes wholly to the split with the most remaining quota (recorded as a `capture-group-overflow:` note) |
| near-duplicates | stub hook only — `nearDuplicateGroups` provider; the embedding-based guard arrives in specs 004/005 |

## Regenerating

```bash
pnpm exec tsx scripts/benchmarks/make-splits.ts \
  --dataset synthetic-fixture \
  --root benchmarks/fixtures/synthetic-fixture \
  --seed 42 --id synthetic-30.gold \
  --out benchmarks/splits/synthetic-30.gold.json
```

The real VisA manifest is produced the same way once the dataset exists — see
`benchmarks/fixtures/README.md` for the exact command.
