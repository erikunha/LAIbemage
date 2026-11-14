# License and attribution audit: `visionlens`

**Date**: 2026-11-14
**Distribution**: `visionlens` 0.1.0 at `python/visionlens/`
**Scope**: the distribution and every dependency that enters the base install, per spec 017 task 4.2.
**Re-audit trigger**: 2026-11-14, the base install gained Pydantic with the typed facade of the
public distribution (`docs/vnext/specs/VLN-003-python-public-wheel.md:14`), so this record was
re-dated and re-run against the installed metadata.

## Position

| Item | Position | Evidence |
|---|---|---|
| Distribution license | MIT, declared in the built metadata as `License-Expression: MIT` | `python/visionlens/pyproject.toml` (`license = "MIT"`); observed in the built wheel METADATA on 2026-11-14 |
| Copyright holder | Erik Cunha | repository root `LICENSE` (MIT, Copyright (c) 2024 Erik Cunha) |
| Base install dependencies | Pydantic, and its four transitive packages, all under permissive licenses; every one of them ships its own license file inside its wheel | `python/visionlens/pyproject.toml` (`dependencies = ["pydantic>=2.12,<3"]`, the base-install policy of `docs/vnext/05-PYTHON-CORE-AND-PYPI.md:34`); the resolved set below, read from the installed metadata on 2026-11-14 |
| Extras | `vision`, `training`, `agents`, `server`, `all` declared with empty dependency sets while the runtime is simulated; no license surface yet | `python/visionlens/pyproject.toml` optional-dependencies |
| Build backend | hatchling (MIT) used at build time only, never installed for consumers | `pyproject.toml` build-system |
| Development tooling | pytest and mypy (both MIT) pinned in `uv.lock` for the development workspace; not part of any install | `python/visionlens/uv.lock` |

## The base install, package by package

Resolved from `python/visionlens/uv.lock` against the base requirement, with the license
read from the installed distribution metadata on 2026-11-14.

| Package | Version | Reached through | License | License file in the wheel |
|---|---|---|---|---|
| pydantic | 2.14.3 | the base requirement | MIT | yes |
| pydantic-core | 2.50.4 | pydantic | MIT | yes |
| annotated-types | 0.8.0 | pydantic | MIT | yes |
| typing-inspection | 0.4.5 | pydantic | MIT | yes |
| typing-extensions | 4.16.0 | pydantic, pydantic-core and typing-inspection | PSF-2.0 | yes |

Every license in the base install is permissive (MIT or PSF-2.0). None is copyleft, none
is source-available, none is a network copyleft obligation, and no base-install package
requires an attribution notice in the distribution's own documentation. The MIT packages
require their copyright notice to travel with them, and it does: each wheel ships its own
license file under `<package>-<version>.dist-info/licenses/LICENSE`, so a consumer install
carries the notices without the distribution having to restate them.

`pydantic-core` is a compiled extension distributed as a platform wheel, not as source:
the base install therefore needs no compiler on any platform that has a wheel for the
running interpreter. The wheel exists for CPython 3.11 through 3.15 on macOS arm64 and
x86_64 and on manylinux, which covers the floor the distribution declares
(`requires-python = ">=3.11"`) and the versions the gate and CI exercise.

## Findings

1. **The MIT license text is not bundled in the artifacts.** The full text lives at the
   repository root (`LICENSE`), outside `python/visionlens/`, and the sdist include list
   (`src`, `tests`, `README.md`, `pyproject.toml`) does not carry it. Declaring
   `License-Expression: MIT` is valid metadata, but distributors commonly ship the text.
   **Gap to close before publication**: copy or link the license text into the sdist
   (for example a `python/visionlens/LICENSE` synced from the root, or a hatchling
   license include), then re-run this audit.
2. The base install is no longer empty, so this audit now has a dependency surface to
   check. It stays green: the five packages above are permissive and each ships its own
   license file. Any further dependency, any filled extra set, or any change to the
   build backend re-triggers this audit.
3. `typing-extensions` is PSF-2.0 rather than MIT. The license is permissive and
   compatible with distributing the package inside an MIT project; it is recorded here
   so the position is explicit rather than inferred from the MIT majority.
4. The versions above are the ones the development lock pins. The worker runtime image
   resolves the published range at build time instead of reading the lock (the image
   carries the wheel source, not the development workspace), so a rebuilt image may
   carry a newer patch within `pydantic>=2.12,<3` than the one audited here. The
   license position of the range is unchanged, and the re-audit rule below fires when
   the range itself changes.

## Re-audit rule

This record must be re-dated whenever `dependencies`, any extra set, the build backend,
or the license declaration changes. The release gate reads this file and fails naming it
when it is missing or undated.
