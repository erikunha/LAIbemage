# The CPU vision adapter

One encoder, one operation, one device. The adapter decodes an image,
preprocesses it with the canonical spec, embeds it on the CPU and
writes the vectors into a content-addressed artifact. The TypeScript
side validates the manifest and commits the derived artifact; the
Python side writes no domain row.

## The pipeline

```text
asset path
  -> resolve inside the approved root        (io/decode.py)
  -> magic bytes vs the name of the file     (io/decode.py)
  -> the type the platform accepts           (io/decode.py)
  -> the file is complete                    (io/decode.py)
  -> the declared size is inside the caps    (io/decode.py)
  -> the pixels                             (io/decode.py)
  -> the pixels in the layout of the model   (io/preprocess.py)
  -> the batch                               (inference/batching.py)
  -> the model                               (encoders/siglip2.py)
  -> the vectors on disk                     (inference/artifact.py)
  -> the manifest                            (inference/artifact.py)
```

Every step that produces a value has a fingerprint, and two runs with
different preprocessing cannot be compared as equivalent
(`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:23`). The
preprocessing fingerprint of the run is the one the registry record
carries: the adapter refuses a preprocessing that is not the record's
one.

## The refusals, in the order they happen

The order is the property. A refusal that arrives after the pixels were
allocated has already cost the memory it was trying to take, and a
refusal that arrives after the bytes were fetched is not a refusal.

| step | what it refuses |
|---|---|
| the root | a path that resolves outside the approved root, and a symlink that escapes it |
| the magic bytes | a file whose bytes are not the type its name claims |
| the allowlist | a type the platform does not accept (the list of `packages/core/src/utils/mime.ts:9`) |
| the completeness | a truncated JPEG and a truncated PNG, before a decoder spends its budget |
| the caps | a declared size over 20000 pixels a side or over 100 million pixels, read from the header before the pixels exist |
| the bytes | a file that is not an image, a file too short to carry the header its type needs, and a metadata that cannot be read |
| the memory | a batch that does not fit, retried with fewer images a bounded number of times |

The caps are the ones the dataset inspector already had
(`python/visionlens/src/visionlens/data/inspect.py`), and so is the
parser of the headers: one implementation reads the dimensions of every
format.

The values that reach the model are channels first: the whole red plane,
then the whole green plane, then the whole blue plane. The layout is
part of the contract of the model, and a run that lays the pixels out
the other way embeds a scrambled image and still returns a vector. The
preprocessing test compares the values with the ones the reference
processor of the model produces, and the recorded difference is 2.57e-08.

## The artifact

The vectors of a run are a binary file beside a manifest, under
`artifacts/<kind>/<run-id>/`
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:33`). The vectors never
travel inside a JSON line and the manifest never carries a base64
payload (`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md:14`).

The manifest carries every field of FR-011, and a value that does not
exist is `unknown` and never `0`
(`docs/vnext/08-DOMAIN-STORE-AND-PROVENANCE.md:24`). The artifact digest
is the address of the CONTENT of the artifact: the model, the revision,
the preprocessing, the snapshot, the assets, the shape and the digest of
the vectors. The run id, the timestamp, the latency, the peak memory,
the runtime versions and the device describe the run and not the
content, so two runs of the same content share the address. The vectors
file digest is the digest of the bytes that were written, and the reader
of an artifact refuses a manifest whose vectors do not hash to the digest
it names.

The manifest schema is generated from the Zod schema the TypeScript
side validates with
(`packages/core/src/adapter/embedding-manifest.ts`), and the generated
file is committed, so the Python side and the TypeScript side validate
against the same contract.

## The golden parity gate

One golden file, read by both languages, and a gate that compares three
tiers and exits non-zero when any of them diverges:

```bash
pnpm exec tsx scripts/benchmarks/vision-parity.ts
```

| tier | what it compares |
|---|---|
| the config fingerprint | the live TypeScript `fingerprintV2` and the one the golden file names |
| the manifest | the manifest of the committed artifact against the ratified schema |
| the vectors | every golden vector against the artifact, inside the documented tolerance |

The golden file is committed, and so is the artifact of the run that
produced it, so the gate runs on a machine that cannot run the model.
The gate never writes the golden file, and a golden file whose vectors
were edited is detected: the digest of the set covers the float32 bytes
of the vectors, and the bytes of a float32 are the same in both
languages.

The tolerance is measured, not guessed. The same images embedded in one
batch and one image at a time differ by at most 1.383e-05 with a cosine
similarity of 1.000000000, and the golden file carries that measurement
and the reason. Widening it is a visible diff.

The fingerprint of the configuration is byte-identical on both sides:
the TypeScript side sorts the object keys by their UTF-16 code units
and writes the numbers the way JavaScript writes them, and the Python
side does the same in one implementation
(`python/visionlens/src/visionlens/runtime/fingerprint.py`).

## The recorded run

The real model, the real weights, the committed fixtures, on the CPU of
a Mac M2 (macOS Darwin 25.6.0 arm64, Python 3.14.6, Pillow 13.0.0,
torch 2.15.0, transformers 4.57.6):

```text
count 6, dimension 768, dtype float32, device cpu, no errors, no fallbacks
p50 651 ms per image, 3.9 s for the six
peak resident memory 824 MiB
vectors file 18432 bytes
vectors file digest 0859460709829bae5db526776df2dbfcc96492055b3134a2da4f2793aa8445a8
artifact digest 4f706336517e10f7194963241c623af1d5039f4fc74fb3bc9c7479bfeaaf586a
config fingerprint fp2:a81b8074dbee1eb8
```

The vectors file digest is the same in every run: the vectors are
reproducible. The command that produced it is
`python/visionlens/scripts/generate_golden.py`, and the tolerance of the
golden file comes from the difference between the batched run and the
one-image-at-a-time run of the same images.

## What this does NOT prove

- The platform has run the model on a **GPU**: this ticket is the CPU
  reference path, and the device planner knows MPS and CUDA but the run
  above is the CPU.
- The embeddings are **calibrated**: the record says `uncalibrated`,
  and no calibrator was fitted. The similarities of the model are not
  probabilities.
- The golden vectors are a **golden comparison of the manifest and the
  fingerprint**, not a two-language encoder comparison: the TypeScript
  side of this platform embeds TEXT, not images. The encoder of this
  ticket is the Python one, and the golden file pins what it produced.
- The `latencyCostProfile` of the record is still `unknown`: the run
  above measured a latency, and the record was not rewritten with it.
