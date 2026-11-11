# Benchmark fixtures — **SYNTHETIC DATA**

> ⚠️ **Everything in this directory is SYNTHETIC.**
> The images are 32×32 solid-colour JPEG blocks with a painted dark patch for
> the "anomalous" ones. They contain **no** photographic information, they are
> **not** a sample of the VisA dataset, and **no accuracy, precision, recall,
> F1, ECE or regression claim may ever be derived from them**. They exist for
> exactly one reason: CI must be able to exercise the whole flow
> (split → score → gate) on every commit without the real dataset, whose
> download needs the maintainer's authorisation (spec 003, US1).

## Shape

```
benchmarks/fixtures/synthetic-fixture/
├── pcb1/                     # class = part name
│   ├── image_anno.csv        # image,mask,label,defect_type,session
│   └── Data/
│       ├── Images/Normal/0000.JPG … 0005.JPG      (6 normal)
│       ├── Images/Anomaly/0000.JPG … 0003.JPG     (4 anomalous)
│       └── Annotations/Anomaly/0000.JPG … 0003.JPG (tiny masks, VisA-shaped)
├── pcb2/                     # same shape
└── capsules/                 # same shape
```

30 images in total (3 parts × (6 normal + 4 anomalous)), each ≈ 1 KB, plus 15
tiny mask images. The tree mirrors the VisA release layout so the split
generator can be exercised against a real-shaped dataset.

`image_anno.csv` follows VisA's column order (`image`, `mask`, `label`,
`defect_type`) and adds one **fixture-only** column: `session`.

| column | meaning |
| --- | --- |
| `image` | path of the image, relative to the part directory |
| `mask` | path of the mask image (empty for normal captures) |
| `label` | `normal` or `anomaly` (mapped to `anomalous` by the generator) |
| `defect_type` | defect taxonomy key of the anomalous capture |
| `session` | capture-session key — the **leakage-aware unit**: items sharing a session are never split across train/val/test |

Real VisA `image_anno.csv` files have **no** `session` column. For the real
dataset the capture sessions come from the normalized store (spec 003, US1);
`make-splits.ts` accepts them through `--groups-file` (a JSON map of relative
image path → capture-group key).

## Regenerating the fixture

```bash
pnpm exec tsx scripts/benchmarks/make-fixture-dataset.ts
```

The generator is deterministic (fixed pixels, fixed EXIF timestamps) and
skips images that already exist, so re-running it never rewrites a file.
Regenerating with a different libjpeg build may produce different bytes —
the committed manifest pins the sha256 of the committed images, so regenerate
the manifest too if you touch the images.

## Regenerating the fixture split

```bash
pnpm exec tsx scripts/benchmarks/make-splits.ts \
  --dataset synthetic-fixture \
  --root benchmarks/fixtures/synthetic-fixture \
  --seed 42 \
  --id synthetic-30.gold \
  --out benchmarks/splits/synthetic-30.gold.json
```

The output is byte-identical on every run (SC-001): the manifest carries **no**
timestamp. Use `--meta` if you want the generation date — it is written to a
sidecar `<out>.meta.json`, never into the manifest.

## The real VisA manifest is intentionally absent

`benchmarks/splits/visa-subset.gold.json` **does not exist yet and must not be
created from synthetic data** — a synthetic file under that name would let a
fake ground truth masquerade as the real one (spec 003, FR-001/FR-003).

Once the real VisA subset has been fetched and normalized, the manifest is
produced with:

```bash
pnpm exec tsx scripts/benchmarks/make-splits.ts \
  --dataset visa-subset \
  --root <datasets dir> \
  --seed 42 \
  --out benchmarks/splits/visa-subset.gold.json
```

`<datasets dir>` is the normalized subset root (default `datasets/visa-subset/`,
see `scripts/datasets/fetch-visa.ts` from spec 003 US1). If the normalized
dataset does not expose a `session` column, pass the capture sessions
explicitly:

```bash
pnpm exec tsx scripts/benchmarks/make-splits.ts \
  --dataset visa-subset \
  --root datasets/visa-subset \
  --seed 42 \
  --groups-file <capture-sessions.json> \
  --out benchmarks/splits/visa-subset.gold.json
```

`capture-sessions.json` maps the relative image path to its capture-session
key. Without it the whole part collapses into a single capture group, the
group no longer fits any 60/20/20 quota, and the split degenerates (the
generator records that as a `capture-group-overflow:` note instead of failing
silently).
