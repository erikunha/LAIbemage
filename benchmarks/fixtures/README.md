# Benchmark fixtures — **SYNTHETIC DATA**

> ⚠️ **Everything in this directory is SYNTHETIC.**
> The images are 32×32 solid-colour JPEG blocks with a painted dark patch for
> the "anomalous" ones. They contain **no** photographic information, they are
> **not** a sample of the VisA dataset, and **no accuracy, precision, recall,
> F1, ECE or regression claim may ever be derived from them**. They exist for
> exactly one reason: CI must be able to exercise the whole flow
> (split → score → gate) on every commit **without the real dataset** — CI
> never downloads a dataset (spec 003, US1). The real VisA ground truth lives
> outside this directory, in `benchmarks/splits/visa-subset.gold.json`
> (see "The real VisA manifest" below).

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

`image_anno.csv` uses the column names of the VisA release — but not its
column order, and with **two fixture-only columns added**: `defect_type` and
`session`. The real release's header is `image,label,mask`; the fixture's is
`image,mask,label,defect_type,session`.

| column | meaning |
| --- | --- |
| `image` | path of the image, relative to the part directory |
| `mask` | path of the mask image (empty for normal captures) |
| `label` | `normal` or `anomaly` (mapped to `anomalous` by the generator) |
| `defect_type` | defect taxonomy key of the anomalous capture |
| `session` | capture-session key — the **leakage-aware unit**: items sharing a session are never split across train/val/test |

Real VisA `image_anno.csv` files have **no** `session` column, and the upstream
release has no `defect_type` and no `class` column either — its header is
`image,label,mask`, where the `label` of an anomalous image is the **defect type**
(`chunk of wax missing`, `bubble`, `melt`, `bent`, …), sometimes quoted and
sometimes a comma-separated list of several defects. `make-splits.ts` accepts
explicit capture groups through `--groups-file` (a JSON map of relative image
path → capture-group key); when the column is absent and no map is given, the
object class is the capture group.

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

## The real VisA manifest

`benchmarks/splits/visa-subset.gold.json` **exists and is committed**. It is
produced from the real subset with:

```bash
pnpm exec tsx scripts/benchmarks/make-splits.ts \
  --dataset visa-subset \
  --root datasets/visa-subset \
  --seed 42 \
  --target-images 700 \
  --out benchmarks/splits/visa-subset.gold.json
```

`datasets/visa-subset/` is the **fetched and extracted** subset — the archive
`VisA_20220922.tar` was fetched on 2026-11-11 and its sha256 is pinned in
`datasets/registry.json`. The layout is **flat**: the object-class directories are
at the top level (`datasets/visa-subset/candle/Data/Images/Normal/0000.JPG`,
`datasets/visa-subset/candle/image_anno.csv`) — there is **no `VisA/` level**. The
dataset binaries are **not in git**; only the registry entry, the manifest, the
predictions and the baseline are tracked.

### What `--target-images` does

Without `--target-images`, the generator splits **every row of every
`image_anno.csv`** — 3506 upstream rows for the four selected parts. With
`--target-images 700`, it selects the **same 700 images the normaliser selects**
for the same tree. The selection is shared code (`collectVisaPartData` +
`selectVisaSubsetImages` in `packages/core/src/benchmark/normalize.ts`), so the
manifest and the normalised store describe **one** subset: 700 assignments
against 700 samples, with identical paths and identical sha256 digests. A
manifest that disagreed with the store would score images the store does not
have.

### The split degenerates — and the manifest says so

The upstream release carries **no** `session` column, so each object class
collapses into a **single capture group** — the class itself. A 100-item group
fits no 60/20/20 quota, so the generator assigns the whole group to `train` and
records a `capture-group-overflow:` note instead of failing silently.

The committed manifest therefore holds **8** such notes — one per class and
anomaly kind — and **every one of its 700 assignments is `split: "train"`**;
`val` and `test` are empty. **The benchmark scores all 700 gold items; there is
no held-out test set.** The upstream release does not carry the session data that
would make a real split possible, and the generator does not invent it.
