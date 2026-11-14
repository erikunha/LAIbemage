# The committed scorecard pointers

This directory holds one pointer file per (suite, model) pair. The pointer is
the **published claim** over artifacts that are deliberately **not** in this
repository.

## Why a pointer and not the artifacts

The per-sample artifact and the scorecard are written under
`benchmarks/results/<scorecardId>/`, which is gitignored: they are large,
they are regenerated, and they carry the per-item detail of a measurement
rather than the claim itself. What is tracked is the pointer, which records
the digest of every artifact it names. A reader can therefore check that the
artifacts behind a published number are the ones the pointer names, and the
repository stays small enough to review.

The pointer directory itself is **not** gitignored. Only `benchmarks/results/`
is (`.gitignore`).

## The file name

`benchmarks/scorecards/<suite>.<model>.json`, for example
`benchmarks/scorecards/visa-subset.v2.gpt-4o.json`. The suite and the model
are the pair the scorecard belongs to, so two models of the same suite never
overwrite one another's pointer.

## The contract

Every pointer carries:

| field | what it is |
|---|---|
| `protocolVersion` | the scorecard protocol version the artifact was written with |
| `scorecardId` | the content-derived id of the scorecard (never the clock) |
| `suite`, `model`, `modelVersion` | what was measured, and the model identity AND version |
| `configFingerprint` | the configuration the measurement used |
| `snapshotId` | the code snapshot the scorecard belongs to |
| `regime` | the metric regime (a scorecard is a test-partition measurement) |
| `manifestSha256` | the hash of the split manifest the scorecard was measured against |
| `testSplitFingerprint` | the digest of the evaluated partition alone |
| `pathBase` | the base the recorded artifact paths are relative to |
| `artifactRefs` | one entry per artifact: its role, relative path, sha256, byte count, row count and whether it is tracked |
| `scorecardSha256` | the digest of the scorecard artifact itself |
| `reproduce` | the command that rebuilds the artifacts, and the note that says what the digests are. A pointer written by the CLI records the scorecard command with every option the measurement depends on, including the required attribution ones, so it runs as it stands |

## What it proves

That a scorecard was measured, with what, against which split, and that the
artifacts behind it hash to the values recorded here. The digests are the
claim: a pointer whose artifact digest does not match is a **failure**, never
a warning.

## What it does not prove

- It does not carry the metrics. The numbers live in the scorecard artifact,
  which is gitignored; the pointer names it and its digest.
- It does not make the measurement reproducible by itself. Reproducing it
  needs the tracked predictions, the tracked split and the code snapshot. The
  recorded `reproduce.command` names the entry point and the options, so it
  runs as it stands; what it cannot name is the CLOCK, which is why the
  scorecard artifact of a re-run never has the digest the pointer records.
  The scorecard id IS stable, because it is derived from the content.
- It does not make a scorecard comparable with a whole-set baseline. The two
  are in different regimes and the gate refuses the comparison.

## The command that reproduces the artifacts

```sh
vision-lens benchmark scorecard \
  --suite visa-subset.v2 \
  --model-id gpt-4o \
  --predictions benchmarks/predictions/visa-subset.v2.gpt-4o.json \
  --model-version <version> \
  --config-fingerprint <hash>
```

The command writes the per-sample artifact, the scorecard and this pointer.
It never downloads a dataset: when the split or the dataset is absent it
prints `dataset=absent` and exits cleanly, and when the scorecard is refused
it prints the error code and writes nothing.
