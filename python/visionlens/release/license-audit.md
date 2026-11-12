# License and attribution audit: `visionlens`

**Date**: 2026-11-12
**Distribution**: `visionlens` 0.1.0 at `python/visionlens/`
**Scope**: the distribution and every dependency that enters the base install, per spec 017 task 4.2.

## Position

| Item | Position | Evidence |
|---|---|---|
| Distribution license | MIT, declared in the built metadata as `License-Expression: MIT` | `python/visionlens/pyproject.toml` (`license = "MIT"`); observed in the built wheel METADATA on 2026-11-12 |
| Copyright holder | Erik Cunha | repository root `LICENSE` (MIT, Copyright (c) 2024 Erik Cunha) |
| Base install dependencies | none; the runtime is standard-library only, so zero third-party packages enter a consumer install and no third-party attribution obligation travels with the base wheel | `python/visionlens/pyproject.toml` (`dependencies = []`); confirmed by the gate's clean-venv `pip list` records |
| Extras | `vision`, `training`, `agents`, `server`, `all` declared with empty dependency sets while the runtime is simulated; no license surface yet | `python/visionlens/pyproject.toml` optional-dependencies |
| Build backend | hatchling (MIT) used at build time only, never installed for consumers | `pyproject.toml` build-system |
| Development tooling | pytest and mypy (both MIT) pinned in `uv.lock` for the development workspace; not part of any install | `python/visionlens/uv.lock` |

## Findings

1. **The MIT license text is not bundled in the artifacts.** The full text lives at the
   repository root (`LICENSE`), outside `python/visionlens/`, and the sdist include list
   (`src`, `tests`, `README.md`, `pyproject.toml`) does not carry it. Declaring
   `License-Expression: MIT` is valid metadata, but distributors commonly ship the text.
   **Gap to close before publication**: copy or link the license text into the sdist
   (for example a `python/visionlens/LICENSE` synced from the root, or a hatchling
   license include), then re-run this audit.
2. No dependency licensing risk exists today because the base install is empty; this
   audit must be re-run whenever a dependency (including Pydantic, proposed by the pack
   for the typed facade) actually enters `dependencies` or any extra.

## Re-audit rule

This record must be re-dated whenever `dependencies`, any extra set, the build backend,
or the license declaration changes. The release gate reads this file and fails naming it
when it is missing or undated.
