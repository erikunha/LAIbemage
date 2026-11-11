# Benchmark ground truth — architecture

> Status: **implemented, dataset not downloaded** · Spec: `specs/003-benchmark-ground-truth`
> (US1–US4) · Revision: `9ef7b95` + spec-003 commits
>
> This document is the map of the benchmark pipeline. The operator's guide for
> the dataset itself lives in [`docs/datasets/visa.md`](../datasets/visa.md).

## 1. What this pipeline is for

Before spec 003, the only "benchmark" in this repository was a synthetic
colour-swatch fixture set, and it was the source of the project's accuracy
claims. `docs/adr/008-evidence-policy.md` forbids that. This pipeline replaces
it with a real, licensed, checksum-verified ground truth and with a single
runner that every later spec must use.

Three properties matter more than the numbers themselves:

1. **Attribution** — no report without the code snapshot, the split
   fingerprint, the model version, the config fingerprint and the environment.
2. **Reproducibility** — the same seed produces the same split, byte for byte.
3. **Honesty about absence** — a missing dataset is a skip with an explicit
   marker, never a failure and never a fabricated number.

```mermaid
flowchart TD
    REG["datasets/registry.json<br/>source · license · version · sha256"]
    FETCH["scripts/datasets/fetch-visa.ts<br/>--check · --offline · sha256 pin"]
    NORM["scripts/datasets/normalize-visa.ts<br/>→ normalizeVisaSubset"]
    STORE[("002 store (sqlite)<br/>capture_sessions · assets · samples<br/>annotations · ontology_versions")]
    SPLIT["packages/core/src/benchmark/splits.ts<br/>seeded · stratified · hash-pinned<br/>benchmarks/splits/*.gold.json"]
    METRICS["packages/core/src/benchmark/metrics.ts<br/>per-class P/R/F1 · macro F1<br/>balanced accuracy · confusion"]
    CALIB["packages/core/src/benchmark/calibration.ts<br/>ECE · 10 equal-width bins"]
    RUNNER["packages/core/src/benchmark/runner.ts<br/>tuple enforcement · integrity gate<br/>JSON + Markdown artifacts"]
    GATE["packages/core/src/benchmark/gate.ts<br/>tolerance −0.02 · per-class deltas"]
    CLI["laib benchmark run | gate | report"]
    ART["benchmarks/results/&lt;runId&gt;/<br/>report.json · report.md"]
    BASE["benchmarks/baselines/&lt;suite&gt;.json<br/>dated header"]

    REG --> FETCH --> NORM --> STORE --> SPLIT
    SPLIT --> RUNNER
    METRICS --> RUNNER
    CALIB --> RUNNER
    RUNNER --> ART
    CLI --> RUNNER
    CLI --> GATE
    ART --> GATE
    GATE --> BASE
    GATE -- "regression" --> FAIL["exit non-zero<br/>regressed classes named"]
```

## 2. The modules

| Module | Responsibility | Purity |
|---|---|---|
| `benchmark/registry.ts` | Typed dataset registry; the license gate. A missing or empty license is a hard error. | pure |
| `benchmark/normalize.ts` | VisA parts → 002-store Samples, CaptureSessions and ontology keys. | pure + I/O at the edge |
| `benchmark/dataset-availability.ts` | `datasetAvailable()` — the `dataset=absent` marker. | pure |
| `benchmark/splits.ts` | Seeded, stratified, hash-pinned gold split generator. | pure |
| `benchmark/metrics.ts` | Per-class P/R/F1, macro F1, balanced accuracy, confusion, latency, cost, budget. | pure |
| `benchmark/calibration.ts` | ECE over 10 equal-width bins + reliability data. | pure |
| `benchmark/runner.ts` | Tuple enforcement, integrity gate, artifact emission. | I/O |
| `benchmark/gate.ts` | Baseline comparison, tolerance, per-class deltas. | I/O |

Specs 006 (arena) and 007 (training) are required by their own specs to import
`@master-vision/core/benchmark` and call these functions, so the platform has a
single metric path. (The legacy synthetic harness in `scripts/benchmark-legacy.ts`
computes its own precision/recall for its own unit fixtures — it is a harness
self-check, not a product metric, and its numbers are never a product claim.)

## 3. Pinned conventions

Two metric numbers are only comparable when the conventions behind them are
identical. These are the conventions this repository fixes — once, and in the
docblock of the function that applies each one.

| Convention | Rule | Where |
|---|---|---|
| Zero division | Precision/recall/F1 of an empty denominator is `0`, never `NaN`. | `metrics.ts` |
| Unseen predicted label | An error: counted wrong, given its own confusion column, listed in `unseenPredictedLabels`, never dropped. | `metrics.ts` |
| Missing prediction | A false negative for its class; the row sum is the support minus the missing count. | `metrics.ts` |
| Percentiles | Linear interpolation between the two closest ranks (type 7 / NumPy default). | `metrics.ts` |
| ECE | `Σ (n_b/N)·|acc_b − conf_b|` over 10 equal-width bins; the last bin is closed at 1.0. | `calibration.ts` |
| Invalid probability | Rejected with a `RangeError` naming the item — never clamped. | `calibration.ts` |
| Budget | Total-USD ceiling; items ordered by cost ascending, ties by id ascending, spent greedily. | `metrics.ts` |
| `minSamples` | The RUNNER's default is 30 (the spec's rule). `scoreMetrics` itself defaults to **1** (no exclusion) so a library caller decides explicitly. A class below the threshold is excluded from the per-class metrics, the macro F1 and the balanced accuracy — loudly, in `excludedClasses` AND in the caveats. | `runner.ts` (`DEFAULT_MIN_SAMPLES`), `metrics.ts` |
| PRNG | mulberry32 (32-bit state, only `Math.imul` and `>>>`). `Math.random` is never used. | `splits.ts` |
| Split quotas | Ratios × 1000 as **integer weights** (so `15 × 0.6` can never land one ULP below an integer), then largest-remainder rounding, ties in the order train > val > test. | `splits.ts` |
| Capture grouping | A capture group is the atom of the assignment and is never split across train/val/test. A group larger than every remaining quota is still assigned wholly, and the deviation is recorded as a `capture-group-overflow:` note. | `splits.ts` |
| Manifest hash | `manifestHash` = sha256 over the contracts' `canonicalJson` of the manifest **without** the hash field. | `splits.ts` |
| Manifest timestamps | None. A timestamp would change the bytes on every run and break byte-stability. | `splits.ts` |
| Gate tolerance | −0.02 on the macro F1. Exactly at the tolerance passes; beyond it fails. The comparison carries a `1e-9` slack so a mathematically exact −0.02 is not failed by float noise. | `gate.ts` |
| Gate comparison | Over the **union** of the baseline's and the current run's class sets, with a class missing from one side counted as `0`. Two runs rarely score the same classes, and the plain macro F1 of each is then not comparable: dropping a badly-scored class RAISES the mean, so a collapsed class could make the gate PASS. | `gate.ts` (`compareMacroF1`) |
| Gate scope | The artifact's suite AND model must match the requested ones, and the baseline is keyed by the **(suite, model, model version)** triple. `gpt-4o` and `gpt-4o-2025-11` are different models: comparing their macro F1 would be a comparison of two different things, so a baseline of another version is not reused. | `commands/benchmark.ts`, `gate.ts` |
| Partial runs | A partial run is skipped by the gate — never compared, never failed. The artifact's own `partial` flag is honoured, not only a CLI flag. A gate that flaps on an outage trains its readers to ignore it. | `gate.ts` |
| Baseline rewrite | A change larger than 0.05 requires an explicit `--force`; the baseline carries a dated header. | `gate.ts` |
| Non-finite inputs | A non-finite latency or cost is REJECTED with a `RangeError` naming the item — never reported. A `NaN` metric serialises as `null` and prints as "NaN ms", and neither reads as "no data". | `metrics.ts` |
| Budget float | The budget comparison carries a `1e-6 USD` slack, so a 0.3 USD budget admits a 0.1 + 0.2 pair whose sum is `0.30000000000000004` in binary floating point. | `metrics.ts` |
| Image bytes | The runner compares the sha256 of the actual bytes with the manifest's — for every item a hash was supplied for. Items without a hash are counted and reported as a caveat: an integrity gate that silently skips the check it could not perform is worse than no gate. | `runner.ts` |

## 4. The reproduction tuple

```mermaid
flowchart LR
    T["ReproductionTuple<br/>exactly five fields"] --> S["snapshotId<br/>the code snapshot"]
    T --> F["splitFingerprint<br/>the split manifest hash"]
    T --> M["modelVersion<br/>model identity AND version"]
    T --> C["configFingerprint<br/>the config hash"]
    T --> E["env<br/>runtime, platform, arch"]
    T --> R["runId<br/>sha256 of the tuple + suite + model<br/>+ the prediction digest"]
    T --> ART["report.json + report.md<br/>both carry the tuple"]
```

`runBenchmark` validates the tuple **before it touches the filesystem**: an
incomplete tuple throws an error naming every missing field, and nothing is
written. The same function refuses to score an image set whose hashes diverge
from the split manifest, and refuses to score a tampered manifest.

The `runId` is derived from the tuple **and** the digest of the prediction set.
Two consequences, both intended: re-running the same evaluation reproduces the
same artifact directory, and two different prediction sets can never overwrite
each other's evidence.

## 5. The CLI

```
laib benchmark run   --suite <name> --model-id <name>
                      --config-fingerprint <hash>
                      --model-version <version>
                      [--split <file>] [--gold <file>] [--predictions <file>]
                      [--out <dir>] [--min-samples <n>] [--partial]
                      [--snapshot-id <id>] [--split-fingerprint <hash>]

laib benchmark gate  --suite <name> --model-id <name>
                      [--metrics <file>] [--baseline <file>] [--tolerance <n>]
                      [--update-baseline] [--force] [--partial]

laib benchmark report --run <runId> [--dir <dir>]
```

`--metrics` has no fixed default path: `run` writes to
`benchmarks/results/<runId>/` and the run id is a hash, so the gate picks the
**most recent artifact belonging to the suite** instead. Pass `--metrics`
explicitly to gate a specific run.

Defaults worth knowing: `--out` is `benchmarks/results`, `--dir` is
`benchmarks/results`, `--min-samples` is `30` and `--tolerance` is `-0.02`.

`--config-fingerprint` and `--model-version` are **required**: a report without
them is not attributed (ADR-008), so the runner refuses it rather than emitting
an empty field. The model version is the model identity AND its version (the
constitutional `model:<id>@<version>` form) — a bare model id is not a version.
The environment capture is filled by the CLI (`captureEnv()` — runtime, platform,
arch); no secret ever reaches an artifact.

> **Why `--model-id` and not `--model`:** the root command already owns
> `--model` (the LLM model of the batch run), and Commander lets the PARENT
> consume an option that appears after a subcommand name — the benchmark
> subcommand would never see it. `--model-id` avoids the collision.

Exit codes: the gate exits `1` when it fails; a skipped gate (missing dataset,
partial run) exits `0` and prints its marker.

## 6. What CI does

The `benchmark-gate` workflow proves two things on every push:

1. **The real-data gate runs when a dataset is available** (`LAIB_DATASETS_DIR`).
   Without one it prints `dataset=absent` and passes. CI never downloads a
   dataset.
2. **The fixture-scale end-to-end always runs**: the synthetic 30-image
   fixture is split, scored, gated and baselined — and then the same pipeline
   runs again with a planted regression (10% of the predictions flipped to a
   wrong label, drawn from a second PRNG stream so the delta is controlled),
   which the gate MUST catch. The assertion checks the gate's OUTPUT — a
   non-zero exit AND the `gate failed` message AND the named regressed
   classes — because a gate that crashes for an unrelated reason also exits
   non-zero, and reading that as "the regression was caught" would be a false
   pass. If the planted regression is not caught, the job fails: a gate that
   does not catch a regression is not a gate.

The fixture-scale run is a **plumbing** check. It is not an accuracy source;
`scripts/benchmark-legacy.ts` (the synthetic colour-swatch harness) is likewise
a unit fixture, and every accuracy claim in the docs points at the spec-003
artifacts instead.

## 7. Status of the real dataset

| | |
|---|---|
| Source | `https://amazon-visual-anomaly.s3.us-west-2.amazonaws.com/VisA_20220922.tar` |
| Size | 1,929,840,640 bytes (≈ 1.93 GB) |
| License | CC BY 4.0 — recorded in `datasets/registry.json` before the first byte is fetched |
| Checksum | `sha256: null` — the object is a **multipart** upload (ETag `…-113`), so the ETag is provenance only, never a checksum. The fetch script computes the sha256 from the received bytes and pins it. |
| Downloaded | **No** — the 1.93 GB fetch needs the maintainer's authorization. |
| Real split manifest | `benchmarks/splits/visa-subset.gold.json` — **not created**. The committed manifest is `synthetic-30.gold.json`, named so that synthetic data can never masquerade as real ground truth. |

The flow is ready end to end:

```bash
pnpm datasets:fetch-visa        # 1.93 GB — needs the maintainer's authorization
pnpm datasets:normalize-visa    # VisA parts → 002 store
pnpm benchmark:splits -- --dataset visa-subset --root datasets/visa-subset --seed 42 \
    --out benchmarks/splits/visa-subset.gold.json
pnpm benchmark:run -- --suite visa-subset --model-id <model> \
    --predictions <predictions.json> --config-fingerprint <hash>
pnpm benchmark:gate -- --suite visa-subset --model-id <model>
```

(The `--` is how pnpm forwards the extra arguments to the script; the CLI flags
themselves are listed in §5.)
