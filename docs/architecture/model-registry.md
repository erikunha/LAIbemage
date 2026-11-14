# The model capability registry

The registry of the models the platform may run. It is data, it is tracked,
and it is a gate: a model the platform does not know is a model the platform
does not run.

## The one file

`datasets/registry.json` holds both registries of this repository:

```text
datasets/registry.json
├── schemaVersion: 2
├── datasets[]          the datasets the platform may use
└── models[]            the models the platform may run
```

Format version 2 added the `models` array. The `datasets` array and the
meaning of every field in it did not change, so a version 1 file is still
read exactly as it was: refusing it would break every reader that has
nothing to do with models. The `models` key is optional in both versions, and
a registry without model records resolves no encoder, which is a refusal and
never a silent default.

The constitution requires it: every dataset and every model records license and
terms before use, in `datasets/registry.json`
(`packages/core/src/benchmark/registry.ts:10`, and the dataset half in
`docs/adr/008-evidence-policy.md:34`). The pack fixes the fields of a model
record (`docs/vnext/11-VISION-MODEL-REGISTRY-INFERENCE.md:5`).

## What a model record is

A record is the platform's knowledge of a model BEFORE it is used: which
bytes it is, exactly which revision, under which license, on which devices,
with which preprocessing. The fields are the pack's list, and every one of
them is filled or explicitly unknown:

| field | what it is |
|---|---|
| `modelId` | the stable id of the model |
| `revision` | an exact commit, never a floating tag |
| `sourceUri` | where the weights live, pinned to that commit |
| `sourceDigest` | the sha256 of the weights, computed from the bytes |
| `license`, `licenseUrl`, `commercialUse`, `usageRestrictions` | the terms |
| `requiredExtras` | the extras the model needs |
| `tasks` | what the model does |
| `preprocessingFingerprint` | the fingerprint of the preprocessing it was measured with |
| `deviceSupport` | the devices the model runs on |
| `inputImageSize`, `outputShape` | what it takes and what it produces |
| `featureExtractor` | the tower it was built with |
| `latencyCostProfile` | the measured latency and cost, or `unknown` |
| `calibrationStatus` | whether the outputs are calibrated |
| `trustPolicy` | the platform's rule for this model |
| `attribution` | the citation the license requires |
| `notes` | the caveats and the provenance |

## The refusals

A record that cannot be trusted is refused, and the refusal names the
offending field:

| the record | the refusal |
|---|---|
| no `sourceDigest` | a record that names bytes it cannot identify is not a record |
| a `sourceDigest` that is not a sha256 | the digest is the promise; a malformed one is none |
| no `license` | a model recorded without terms is a model nobody may run |
| no `deviceSupport` | a model that runs nowhere is a record of nothing |
| a device outside `cpu`, `mps`, `cuda` | the vocabulary is fixed; a device nobody has is a guess |
| the revision `latest` | a floating revision can never back a saved run |
| a `sourceUri` or `licenseUrl` that is not an absolute URL with a host | the weights location is the promise the digest hangs on, and `mailto:` is not a place bytes live |
| an empty `trustPolicy`, `attribution`, `featureExtractor`, `preprocessingFingerprint`, `latencyCostProfile` or `calibrationStatus` | the rule and the citation are not optional |
| a field of the wrong type (`commercialUse` as a string, `outputShape.dimension` as text) | a reader that coerces would accept a record the other reader refuses |
| a field that is absent | a field that is absent is a refusal, never a default |
| a field the record does not define | a misspelled field nobody sees is a field nobody maintains |

Both readers refuse the same records, and both name the offending field by
the path the FILE uses (`models.0.sourceDigest`,
`models.0.inputImageSize.width`). One refusal means one thing in both
languages.

The parity is measured, not asserted, and the measurement is a command:

```bash
pnpm exec tsx scripts/registry/parity-check.ts
```

The check builds a corpus of malformed registries (every field of a model
record and of a dataset entry dropped, emptied, mistyped and nulled, plus
the envelope), feeds the same files to both readers, and compares the
outcome and the field each one names. It reports 257 cases, no outcome
disagreement and eight naming differences, and it exits non-zero when the
two readers disagree about a file. The eight differences are two kinds: the
TypeScript reader names the object that carries an unknown key and puts the
key in the message (`models.0: Unrecognized key: "mysteryField"`), while the
Python reader names the key in the path (`models.0.mysteryField`); and the
TypeScript reader names both sides of the sha256 pairing
(`datasets.0.sha256` and `datasets.0.sha256PinnedAt`), while the Python
reader names the field that is wrong.

## The two readers

| reader | what it is |
|---|---|
| `packages/core/src/benchmark/registry.ts` | the TypeScript reader: `ModelRegistryEntrySchema` (`:209`), `findModel` (`:410`) |
| `python/visionlens/src/visionlens/registry/loader.py` | the Python reader: `record_from_mapping` (`:203`), `load_model_registry` (`:334`), `resolve_model` (`:425`) |
| `python/visionlens/src/visionlens/registry/record.py` | the Python record and its refusals (`ModelRecord`, `:133`) |

The Python side lives under `visionlens/registry/`, next to the SIMULATED
registry (`visionlens/registry/simulated.py`). The two are not the same
thing, and the difference matters: the simulated registry is the frozen list
the SIMULATED runtime derives deterministic vectors from, its revisions are
placeholders, and it is what runs today. Its `siglip2-base` entry carries
the same model id as the capability record, with a placeholder revision
(`r2026-03-01`) and the simulated dimension. It describes the simulated
runtime, never the checkpoint: the real model's bytes and revision live in
the capability record and nowhere else, and the licence string the simulated
entry carries is the licence of the simulation, not a record of the
checkpoint.

Resolving a model reads a FILE and nothing else. It never reaches the
network: the record says which bytes the model is, and fetching those bytes
is a separate, explicitly permitted act (the weights loader, still open in
`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md`). A resolution that quietly downloaded the weights would make the
digest a decoration instead of a promise. The Python test proves it by
breaking the socket module before resolving.

## The record published today

`siglip2-base`, pinned from the real bytes on 2026-11-14:

| | |
|---|---|
| the source | `google/siglip2-base-patch16-224` at commit `75de2d55ec2d0b4efc50b3e9ad70dba96a7b2fa2` |
| the weights | `model.safetensors`, 1,500,800,904 bytes, sha256 `612923381c76ec5a9bed335d1c48827e3f2e506ac31b044b63b2031fadee6a0b` |
| the license | `apache-2.0`, commercial use permitted |
| the shape | 224x224 input, 768-dimension output, a 16-pixel patch |
| the preprocessing | `fp2:83adc4ef99979644` |
| the devices | `cpu`, the path this platform implements |

The facts came from the pinned artifacts themselves: the digest from the
bytes of the weights and the byte count with them, the output dimension and
the patch size from the safetensors header, and the input size and the
preprocessing from the processor config of that revision (sha256
`9b36b57ebaf20f09bf4c22100ccc21877ea6bfe5aead0c00c59f8af8ccefacfc`).

The preprocessing fingerprint is not a literal anybody has to trust: the
repository computes it with its own algorithm
(`visionlens.encoder.fingerprint_of_components`) from the pinned config, and
the test that recomputes it and compares it with the tracked record is the
guard
(`python/visionlens/tests/test_preprocessing_fingerprint.py`). The simulated
pipeline has its own fingerprint (`fp2:b954b202e7527fc5`), because the
simulated encoder is not this model.

## What this record does NOT prove

- The platform has **not run this model**. The CPU adapter is a later task
  of this ticket. The record states what the model IS, not a measurement.
- The `latencyCostProfile` is `unknown`, because nothing was measured yet.
- The `deviceSupport` list names the CPU path, the one this platform
  implements. The model card declares no device support, so the record
  claims no other device: an inference dressed as a fact is not a fact.
- The `calibrationStatus` is `uncalibrated`: no calibrator was fitted, and
  the model's own similarities are not calibrated probabilities.
- The `trustPolicy` is a declaration, not an enforcement. Nothing yet
  refuses a download because of it (the weights loader is still open).
- The `featureExtractor` is the tower's configuration type
  (`siglip_vision_model`), not a HuggingFace feature-extractor class.
- The `vision` extra the record names carries no dependency yet.

## What comes next

The weights loader, still open in
`docs/vnext/specs/VLN-005-python-cpu-vision-adapter.md`: a download happens
only with an explicit permission, only from an allowlisted source at the
pinned revision, only as safetensors, and only after the digest of the bytes
matches the record. That loader owns the license gate, and it is the place
where a forbidden use is refused before a single byte is fetched.
