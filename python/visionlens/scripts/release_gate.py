"""Release gate for the visionlens distribution. It publishes nothing.

Every step records its command, environment, exit code and output into a
dated evidence artifact under release/gate/, and the gate exits non-zero when
any step fails or cannot run (a missing check is a failed gate, never a
silent pass). The steps:

1. build: uv build must produce exactly one wheel and one sdist; twine check
   (installed into an ephemeral venv) must pass on both.
2. clean install: a fresh venv installs the wheel, a second fresh venv
   installs the sdist, both with every directory containing node removed
   from PATH; import visionlens must exit 0, report 0.1.0, expose py.typed
   and load none of the heavy optional modules.
3. artifact scan: neither artifact may contain a model checkpoint, a dataset
   file, a .env file, a credential, or an absolute build-machine path.
4. extras: each of the five extras resolves alone from the wheel, and the
   four capability extras resolve together into one coherent environment (the
   `all` extra resolves alone, like each of the others).
5. records: release/registry-availability.json and release/license-audit.md
   exist and carry a date; the gate fails naming any missing record.
6. lock compatibility: uv lock --check proves the uv.lock pins still satisfy
   the published pyproject ranges, and the lock records its exclude-newer
   cutoff.
7. dependency scan: pip-audit runs over the exported development
   requirements and every finding is recorded with its severity; a
   high-severity (or unsized, unreviewed) finding fails the gate. The
   severity is read from OSV, the advisory database the identifiers pip-audit
   reports come from, because pip-audit reports the finding without one.
   Reviewed findings are listed in release/dependency-scan-reviewed.json, a
   JSON array of objects whose `id` is the identifier pip-audit reports.

Run: python3 python/visionlens/scripts/release_gate.py
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
import math
import os
import platform
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any, Callable, Sequence

PKG_ROOT = Path(__file__).resolve().parents[1]
RELEASE_DIR = PKG_ROOT / "release"
GATE_DIR = RELEASE_DIR / "gate"
DIST_DIR = PKG_ROOT / "dist"

EXTRAS = ("vision", "training", "agents", "server", "all")
HEAVY_MODULES = (
    "torch",
    "transformers",
    "mlflow",
    "langgraph",
    "fastapi",
    "uvicorn",
    "scikit-learn",
)

# Artifact scan: filename rules. Checkpoints, datasets, images and credential
# files never ship; the frozen protocol transcript is content, not a dataset.
CHECKPOINT_SUFFIXES = (
    ".pt", ".pth", ".ckpt", ".safetensors", ".onnx", ".h5", ".gguf", ".bin", ".msgpack",
)
DATASET_SUFFIXES = (
    ".csv", ".tsv", ".parquet", ".arrow", ".feather", ".npz", ".npy",
)
IMAGE_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff")
CREDENTIAL_SUFFIXES = (".pem", ".key", ".p12", ".pfx")
CREDENTIAL_NAME_RE = re.compile(
    r"(^|.*/)(\.env($|\.)|id_dsa|id_ecdsa|id_ed25519|id_rsa|known_hosts|credentials|.*_credentials)$"
)
ALLOWED_NAMES = {"visionlens/golden/session.jsonl"}

CONTENT_PATTERNS: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    ("private key block", re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("AWS access key id", re.compile(rb"AKIA[0-9A-Z]{16}")),
    ("GitHub token", re.compile(rb"ghp_[A-Za-z0-9]{20,}")),
    ("Slack token", re.compile(rb"xox[baprs]-[0-9A-Za-z-]{10,}")),
)
# Assembled at runtime so this file's own source carries no literal machine
# path (the repository's meta guard forbids the literal in tracked files).
ABSOLUTE_PATH_PATTERNS = (b"/" + b"Users" + b"/", b"/home/", b"/private/var/")

IMPORT_CHECK = (
    "import pathlib, sys, visionlens\n"
    "assert visionlens.__version__ == '0.1.0', visionlens.__version__\n"
    "assert (pathlib.Path(visionlens.__file__).parent / 'py.typed').exists()\n"
    "heavy = [m for m in "
    + repr(HEAVY_MODULES)
    + " if m in sys.modules]\n"
    "assert not heavy, heavy\n"
    "print('CLEAN')\n"
)

PASS = "pass"
FAIL = "fail"
NOT_RUN = "not-run"


@dataclasses.dataclass
class Step:
    """One recorded gate step."""

    name: str
    status: str
    command: str = ""
    exit_code: int | None = None
    detail: str = ""
    output: str = ""


class Gate:
    """Collects step records and fails closed."""

    def __init__(self) -> None:
        self.steps: list[Step] = []

    def record(self, step: Step) -> None:
        self.steps.append(step)
        marker = {PASS: "PASS", FAIL: "FAIL", NOT_RUN: "NOT RUN"}[step.status]
        print(f"[{marker}] {step.name}" + (f": {step.detail}" if step.detail else ""))

    @property
    def ok(self) -> bool:
        return all(step.status == PASS for step in self.steps)


def run(
    command: Sequence[str],
    *,
    env: dict[str, str] | None = None,
    cwd: Path | None = None,
    timeout: int = 600,
) -> subprocess.CompletedProcess[str]:
    """Run one subprocess, capturing output, never raising."""
    return subprocess.run(
        list(command),
        env=env,
        cwd=None if cwd is None else str(cwd),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def clean_env(*, without_node: bool = False) -> dict[str, str]:
    """A sanitized child environment; optionally with node removed from PATH."""
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "VIRTUAL_ENV")}
    if without_node:
        keep = [
            d
            for d in env.get("PATH", "").split(os.pathsep)
            if d and not os.path.exists(os.path.join(d, "node"))
        ]
        env["PATH"] = os.pathsep.join(keep)
    return env


def node_absent(env: dict[str, str]) -> bool:
    return shutil.which("node", path=env.get("PATH", "")) is None


def make_venv(root: Path, env: dict[str, str]) -> Path:
    """Create a fresh venv and return the path of its python binary."""
    created = run([sys.executable, "-m", "venv", str(root)], env=env, timeout=300)
    if created.returncode != 0:
        raise RuntimeError("venv creation failed: " + created.stderr)
    return root / "bin" / "python"


def pip_install(python: Path, what: str, env: dict[str, str], timeout: int = 600) -> Step:
    installed = run([str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", what], env=env, timeout=timeout)
    extra_warning = "does not provide the extra" in (installed.stderr + installed.stdout)
    if installed.returncode != 0 or extra_warning:
        detail = "pip install failed"
        if extra_warning:
            detail = "pip reported an unknown extra in the built metadata"
        return Step("install", FAIL, f"pip install {what}", installed.returncode, detail, installed.stderr[-2000:])
    listed = run([str(python), "-m", "pip", "list", "--format=freeze"], env=env, timeout=120)
    return Step("install", PASS, f"pip install {what}", installed.returncode, "", listed.stdout)


def git_sha() -> str:
    probed = run(["git", "-C", str(PKG_ROOT.parent.parent), "rev-parse", "HEAD"], timeout=30)
    return probed.stdout.strip() if probed.returncode == 0 else "unknown"


# ---------------------------------------------------------------- step 1

def step_build(gate: Gate, tmp: Path) -> tuple[Path, Path] | None:
    if shutil.which("uv") is None:
        gate.record(Step("build", NOT_RUN, detail="uv is not installed"))
        return None
    if DIST_DIR.exists():
        for stale in DIST_DIR.iterdir():
            if stale.is_file():
                stale.unlink()
    built = run(["uv", "build", "--out-dir", str(DIST_DIR)], cwd=PKG_ROOT, timeout=600)
    wheels = sorted(DIST_DIR.glob("*.whl")) if DIST_DIR.exists() else []
    sdists = sorted(DIST_DIR.glob("*.tar.gz")) if DIST_DIR.exists() else []
    if built.returncode != 0 or len(wheels) != 1 or len(sdists) != 1:
        gate.record(
            Step(
                "build",
                FAIL,
                "uv build --out-dir dist",
                built.returncode,
                f"expected exactly one wheel and one sdist, found {len(wheels)} wheels and {len(sdists)} sdists",
                built.stderr[-2000:],
            )
        )
        return None
    gate.record(
        Step("build", PASS, "uv build --out-dir dist", built.returncode, f"{wheels[0].name} + {sdists[0].name}")
    )

    twine_env = clean_env()
    try:
        twine_python = make_venv(tmp / "twine-venv", twine_env)
        twine_install = run(
            [str(twine_python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "twine"],
            env=twine_env,
            timeout=600,
        )
        if twine_install.returncode != 0:
            gate.record(
                Step("metadata-validation", NOT_RUN, "pip install twine (ephemeral venv)", twine_install.returncode,
                     "twine could not be installed; no equivalent validator ran", twine_install.stderr[-1500:])
            )
            return wheels[0], sdists[0]
        checked = run(
            [str(twine_python), "-m", "twine", "check", str(wheels[0]), str(sdists[0])],
            env=twine_env,
            timeout=300,
        )
        gate.record(
            Step(
                "metadata-validation",
                PASS if checked.returncode == 0 else FAIL,
                "twine check <wheel> <sdist>",
                checked.returncode,
                "",
                checked.stdout[-1500:] + checked.stderr[-1500:],
            )
        )
    except Exception as error:  # pragma: no cover - defensive
        gate.record(Step("metadata-validation", NOT_RUN, detail=f"validator setup failed: {error}"))
    return wheels[0], sdists[0]


# ---------------------------------------------------------------- step 2

def step_clean_venv_install(gate: Gate, tmp: Path, wheel: Path, sdist: Path) -> None:
    env = clean_env(without_node=True)
    details = [f"node on PATH: {'absent' if node_absent(env) else 'PRESENT'}"]
    if not node_absent(env):
        gate.record(Step("clean-venv-install", FAIL, detail="node could not be removed from PATH"))
        return
    for label, artifact in (("wheel", wheel), ("sdist", sdist)):
        try:
            python = make_venv(tmp / f"install-{label}-venv", env)
            install = pip_install(python, str(artifact), env)
            if install.status != PASS:
                gate.record(Step(f"clean-venv-install ({label})", FAIL, install.command, install.exit_code, install.detail, install.output))
                continue
            check = run([str(python), "-c", IMPORT_CHECK], env=env, timeout=120)
            status = PASS if check.returncode == 0 and check.stdout.strip() == "CLEAN" else FAIL
            gate.record(
                Step(
                    f"clean-venv-install ({label})",
                    status,
                    f"venv python -m pip install <{label}>; python -c 'import visionlens'",
                    check.returncode,
                    "; ".join(details),
                    (check.stdout + check.stderr)[-1500:] + "\n" + install.output[-800:],
                )
            )
        except Exception as error:
            gate.record(Step(f"clean-venv-install ({label})", NOT_RUN, detail=str(error)))


# ---------------------------------------------------------------- step 3

def _scan_names(names: Sequence[str]) -> list[str]:
    hits: list[str] = []
    for name in names:
        normalized = name.split("/", 1)[1] if "/" in name and not name.startswith(".") else name
        base = name.rsplit("/", 1)[-1].lower()
        if normalized in ALLOWED_NAMES or name in ALLOWED_NAMES:
            continue
        if any(base.endswith(s) for s in CHECKPOINT_SUFFIXES + DATASET_SUFFIXES + IMAGE_SUFFIXES + CREDENTIAL_SUFFIXES):
            hits.append(name)
        elif CREDENTIAL_NAME_RE.match(base):
            hits.append(name)
        elif base == ".env" or base.startswith(".env."):
            hits.append(name)
    return hits


def _scan_content(name: str, payload: bytes, root: bytes) -> list[str]:
    hits: list[str] = []
    for label, pattern in CONTENT_PATTERNS:
        if pattern.search(payload):
            hits.append(f"{name}: credential pattern {label}")
    for marker in ABSOLUTE_PATH_PATTERNS + (root,):
        if marker and marker in payload:
            hits.append(f"{name}: absolute build path {marker.decode('utf-8', 'replace')}")
    return hits


def step_artifact_scan(gate: Gate, wheel: Path, sdist: Path) -> None:
    hits: list[str] = []
    try:
        with zipfile.ZipFile(wheel) as archive:
            hits += _scan_names(archive.namelist())
            for name in archive.namelist():
                if name.endswith("/"):
                    continue
                hits += _scan_content(name, archive.read(name), str(PKG_ROOT).encode())
    except Exception as error:
        gate.record(Step("artifact-scan (wheel)", NOT_RUN, detail=str(error)))
        return
    try:
        with tarfile.open(sdist) as archive:
            names = [m.name for m in archive.getmembers() if m.isfile()]
            hits += _scan_names(names)
            for member in archive.getmembers():
                if not member.isfile():
                    continue
                stream = archive.extractfile(member)
                if stream is None:
                    continue
                hits += _scan_content(member.name, stream.read(), str(PKG_ROOT).encode())
    except Exception as error:
        gate.record(Step("artifact-scan (sdist)", NOT_RUN, detail=str(error)))
        return
    status = FAIL if hits else PASS
    gate.record(
        Step(
            "artifact-scan",
            status,
            f"scan {wheel.name} and {sdist.name}",
            None,
            f"{len(hits)} forbidden hit(s)" if hits else "no checkpoint, dataset, credential or absolute path",
            "\n".join(hits[:40]),
        )
    )


# ---------------------------------------------------------------- step 4

def step_extras_resolution(gate: Gate, tmp: Path, wheel: Path) -> None:
    if shutil.which("uv") is None:
        gate.record(Step("extras-resolution", NOT_RUN, detail="uv is not installed"))
        return
    env = clean_env(without_node=True)
    for extra in EXTRAS:
        try:
            venv = tmp / f"extra-{extra}-venv"
            python = make_venv(venv, env)
            requirement = f"visionlens[{extra}] @ file://{wheel.resolve()}"
            install = pip_install(python, requirement, env)
            gate.record(
                Step(
                    f"extras-resolution [{extra}]",
                    install.status,
                    f"pip install '{requirement}'",
                    install.exit_code,
                    install.detail,
                    install.output[-600:],
                )
            )
        except Exception as error:
            gate.record(Step(f"extras-resolution [{extra}]", NOT_RUN, detail=str(error)))
    # The coherent combined environment: all extras in one resolve.
    try:
        venv = tmp / "extra-all-combined-venv"
        python = make_venv(venv, env)
        requirement = f"visionlens[{','.join(EXTRAS[:-1])}] @ file://{wheel.resolve()}"
        install = pip_install(python, requirement, env)
        gate.record(
            Step(
                "extras-resolution [all combined]",
                install.status,
                f"pip install '{requirement}'",
                install.exit_code,
                install.detail,
                install.output[-600:],
            )
        )
    except Exception as error:
        gate.record(Step("extras-resolution [all combined]", NOT_RUN, detail=str(error)))


# ---------------------------------------------------------------- step 5

def step_records(gate: Gate) -> None:
    registry = RELEASE_DIR / "registry-availability.json"
    audit = RELEASE_DIR / "license-audit.md"
    date_re = re.compile(r"\d{4}-\d{2}-\d{2}")
    if not registry.is_file():
        gate.record(Step("release-records", FAIL, detail=f"missing record: {registry.relative_to(PKG_ROOT)}"))
        return
    try:
        payload = json.loads(registry.read_text(encoding="utf-8"))
        has_date = bool(date_re.search(str(payload.get("checkedAt", ""))))
        has_result = bool(str(payload.get("result", "")))
    except Exception as error:
        gate.record(Step("release-records", FAIL, detail=f"unreadable {registry.name}: {error}"))
        return
    if not has_date or not has_result:
        gate.record(Step("release-records", FAIL, detail=f"{registry.name} must carry a checkedAt date and a result"))
        return
    if not audit.is_file():
        gate.record(Step("release-records", FAIL, detail=f"missing record: {audit.relative_to(PKG_ROOT)}"))
        return
    if not date_re.search(audit.read_text(encoding="utf-8")):
        gate.record(Step("release-records", FAIL, detail=f"{audit.name} must carry a date"))
        return
    gate.record(Step("release-records", PASS, "read release/registry-availability.json and release/license-audit.md", 0))


# ---------------------------------------------------------------- step 6

def step_lock_compatibility(gate: Gate) -> None:
    lock = PKG_ROOT / "uv.lock"
    if shutil.which("uv") is None or not lock.is_file():
        gate.record(Step("lock-compatibility", NOT_RUN, detail="uv or uv.lock is missing"))
        return
    checked = run(["uv", "lock", "--check"], cwd=PKG_ROOT, timeout=300)
    cutoff_recorded = "exclude-newer" in lock.read_text(encoding="utf-8")
    status = PASS if checked.returncode == 0 and cutoff_recorded else FAIL
    detail = ""
    if not cutoff_recorded:
        detail = "uv.lock does not record the exclude-newer cutoff"
    gate.record(
        Step(
            "lock-compatibility",
            status,
            "uv lock --check",
            checked.returncode,
            detail or "lock pins satisfy the published pyproject ranges",
            checked.stderr[-800:],
        )
    )


# ---------------------------------------------------------------- step 7

OSV_API = "https://api.osv.dev/v1/vulns/"

# The qualitative severities OSV and the advisory databases use, mapped to the
# bands the gate reasons about.
SEVERITY_LABELS = {
    "LOW": "low",
    "MODERATE": "medium",
    "MEDIUM": "medium",
    "HIGH": "high",
    "CRITICAL": "critical",
}

# The CVSS v3.1 base score weights (FIRST, section 8.1 and 8.2).
CVSS_AV = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.20}
CVSS_AC = {"L": 0.77, "H": 0.44}
CVSS_UI = {"N": 0.85, "R": 0.62}
CVSS_IMPACT = {"H": 0.56, "L": 0.22, "N": 0.00}
CVSS_PR = {"N": 0.85, "L": 0.62, "H": 0.27}
CVSS_PR_CHANGED = {"N": 0.85, "L": 0.68, "H": 0.50}

# The severity a finding carries when no authority could size it. It blocks
# the gate, because an unsized finding is an unreviewed one.
UNSPECIFIED_SEVERITY = "unspecified"


def cvss_base_score(vector: str) -> float | None:
    """The CVSS v3.1 base score of a vector string, or None when unreadable."""
    if not vector.startswith("CVSS:3."):
        return None
    metrics: dict[str, str] = {}
    for part in vector.split("/")[1:]:
        key, _, value = part.partition(":")
        metrics[key] = value
    try:
        scope_changed = metrics["S"] == "C"
        privileges = (CVSS_PR_CHANGED if scope_changed else CVSS_PR)[metrics["PR"]]
        confidentiality = CVSS_IMPACT[metrics["C"]]
        integrity = CVSS_IMPACT[metrics["I"]]
        availability = CVSS_IMPACT[metrics["A"]]
        attack_vector = CVSS_AV[metrics["AV"]]
        attack_complexity = CVSS_AC[metrics["AC"]]
        user_interaction = CVSS_UI[metrics["UI"]]
    except KeyError:
        return None
    subscore = 1 - ((1 - confidentiality) * (1 - integrity) * (1 - availability))
    if scope_changed:
        impact = 7.52 * (subscore - 0.029) - 3.25 * (subscore - 0.02) ** 15
    else:
        impact = 6.42 * subscore
    if impact <= 0:
        return 0.0
    exploitability = 8.22 * attack_vector * attack_complexity * privileges * user_interaction
    if scope_changed:
        return cvss_roundup(min(1.08 * (impact + exploitability), 10))
    return cvss_roundup(min(impact + exploitability, 10))


def cvss_roundup(value: float) -> float:
    """The CVSS 3.1 Roundup: the smallest one-decimal number not below the input."""
    scaled = int(round(value * 100000))
    if scaled % 10000 == 0:
        return scaled / 100000.0
    return (math.floor(scaled / 10000) + 1) / 10.0


def severity_band(score: float | None) -> str | None:
    """The qualitative band of a CVSS base score, or None when there is no score."""
    if score is None:
        return None
    if score == 0.0:
        return "none"
    if score < 4.0:
        return "low"
    if score < 7.0:
        return "medium"
    if score < 9.0:
        return "high"
    return "critical"


def severity_from_osv(payload: dict[str, Any]) -> str | None:
    """The severity of an OSV advisory, or None when the advisory carries none.

    The advisory's own qualitative severity wins. A CVSS vector is scored only
    when the advisory carries no label.
    """
    label = (payload.get("database_specific") or {}).get("severity")
    if isinstance(label, str):
        mapped = SEVERITY_LABELS.get(label.strip().upper())
        if mapped:
            return mapped
    for affected in payload.get("affected") or []:
        label = (affected.get("ecosystem_specific") or {}).get("severity")
        if isinstance(label, str):
            mapped = SEVERITY_LABELS.get(label.strip().upper())
            if mapped:
                return mapped
    for entry in payload.get("severity") or []:
        band = severity_band(cvss_base_score(str(entry.get("score", ""))))
        if band and band != "none":
            return band
    return None


def osv_severity(identifier: str) -> str | None:
    """The severity OSV holds for an advisory identifier, or None."""
    url = OSV_API + urllib.parse.quote(identifier)
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return None
    if not isinstance(payload, dict):
        return None
    return severity_from_osv(payload)


def finding_severity(
    vulnerability: dict[str, Any], cache: dict[str, str | None]
) -> str:
    """The severity of one finding, read from OSV.

    pip-audit reports what is affected and how to fix it, but never a
    severity, so the severity is read from OSV, the advisory database the
    identifiers pip-audit reports come from. The finding's own identifier is
    tried first, then its aliases, which is where the GitHub advisory and the
    CVE identifier live.
    """
    identifiers = [str(vulnerability.get("id", ""))]
    identifiers.extend(str(alias) for alias in vulnerability.get("aliases", []))
    for identifier in identifiers:
        if not identifier:
            continue
        if identifier not in cache:
            cache[identifier] = osv_severity(identifier)
        severity = cache[identifier]
        if severity:
            return severity
    return UNSPECIFIED_SEVERITY


def collect_findings(
    findings: dict[str, Any], severity_of: Callable[[dict[str, Any]], str]
) -> list[dict[str, Any]]:
    """Every finding of a pip-audit report, with its severity.

    pip-audit names the list of findings `vulns`; the report is read with
    that name, and `vulnerabilities` is accepted as well so a report from
    another producer is still read rather than silently reported as empty.

    A finding is recorded once. pip-audit lists a vulnerability once per
    affected range, so the same identifier comes back more than once.
    """
    collected: list[dict[str, Any]] = []
    seen: dict[tuple[str, str, str], dict[str, Any]] = {}
    for dependency in findings.get("dependencies", []):
        vulnerabilities = dependency.get("vulns")
        if vulnerabilities is None:
            vulnerabilities = dependency.get("vulnerabilities") or []
        for vulnerability in vulnerabilities:
            package = str(dependency.get("name", "unknown"))
            version = str(dependency.get("version", "unknown"))
            identifier = str(vulnerability.get("id", "unknown"))
            key = (package, version, identifier)
            aliases = [str(alias) for alias in vulnerability.get("aliases", [])]
            fix_versions = [str(fix) for fix in vulnerability.get("fix_versions", [])]
            if key in seen:
                recorded = seen[key]
                recorded["aliases"] = list(dict.fromkeys(recorded["aliases"] + aliases))
                recorded["fixVersions"] = list(dict.fromkeys(recorded["fixVersions"] + fix_versions))
                continue
            finding = {
                "package": package,
                "version": version,
                "id": identifier,
                "severity": severity_of(vulnerability),
                "aliases": aliases,
                "fixVersions": fix_versions,
            }
            seen[key] = finding
            collected.append(finding)
    return collected


def blocking_findings(
    collected: list[dict[str, Any]], reviewed: dict[str, dict[str, Any]]
) -> list[str]:
    """The findings that block the gate: an unreviewed high or unsized one.

    A reviewed finding is recorded in release/dependency-scan-reviewed.json
    and no longer blocks, whatever its severity.
    """
    blocking: list[str] = []
    for finding in collected:
        if finding["id"] in reviewed:
            continue
        severity = finding["severity"]
        entry = f"{finding['package']} {finding['version']}: {finding['id']} severity={severity}"
        if severity in ("high", "critical"):
            blocking.append(entry + " (unreviewed)")
        elif severity == UNSPECIFIED_SEVERITY:
            blocking.append(entry + " (no severity reported; review or record it to proceed)")
    return blocking


def step_dependency_scan(gate: Gate, tmp: Path) -> None:
    if shutil.which("uv") is None:
        gate.record(Step("dependency-scan", NOT_RUN, detail="uv is not installed"))
        return
    env = clean_env()
    requirements = tmp / "requirements-dev.txt"
    exported = run(
        [
            "uv", "export", "--group", "dev", "--no-hashes", "--no-emit-project",
            # `--locked` keeps the export faithful to the COMMITTED lock: without
            # it, uv re-resolves and can rewrite `uv.lock`, and the scan would
            # audit a set that is not the lock the repository ships.
            "--locked",
            "--format", "requirements.txt", "-o", str(requirements),
        ],
        cwd=PKG_ROOT,
        env=env,
        timeout=300,
    )
    if exported.returncode != 0:
        gate.record(Step("dependency-scan", NOT_RUN, "uv export --group dev", exported.returncode,
                         "the development requirements could not be exported", exported.stderr[-1500:]))
        return
    try:
        python = make_venv(tmp / "pip-audit-venv", env)
        tool_install = run(
            [str(python), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "pip-audit"],
            env=env,
            timeout=600,
        )
        if tool_install.returncode != 0:
            gate.record(Step("dependency-scan", NOT_RUN, "pip install pip-audit (ephemeral venv)", tool_install.returncode,
                             "pip-audit could not be installed", tool_install.stderr[-1500:]))
            return
        findings_json = tmp / "pip-audit-findings.json"
        audited = run(
            [str(python), "-m", "pip_audit", "-r", str(requirements), "--format", "json", "-o", str(findings_json)],
            env=env,
            timeout=900,
        )
        if not findings_json.is_file():
            gate.record(Step("dependency-scan", NOT_RUN, "pip-audit -r requirements-dev.txt", audited.returncode,
                             "no scan output was produced", (audited.stdout + audited.stderr)[-1500:]))
            return
        findings = json.loads(findings_json.read_text(encoding="utf-8"))
        reviewed = _reviewed_findings()
        severity_cache: dict[str, str | None] = {}
        collected = collect_findings(
            findings, lambda vulnerability: finding_severity(vulnerability, severity_cache)
        )
        blocking = blocking_findings(collected, reviewed)
        detail = f"{len(collected)} finding(s) recorded with severity"
        status = FAIL if blocking else PASS
        gate.record(
            Step(
                "dependency-scan",
                status,
                f"pip-audit -r {requirements.name} (exported from uv.lock)",
                audited.returncode,
                detail + ("; blocking: " + "; ".join(blocking[:10]) if blocking else "; none blocking"),
                json.dumps(collected, indent=2),
            )
        )
    except Exception as error:
        gate.record(Step("dependency-scan", NOT_RUN, detail=str(error)))


def _reviewed_findings() -> dict[str, dict[str, Any]]:
    path = RELEASE_DIR / "dependency-scan-reviewed.json"
    if not path.is_file():
        return {}
    try:
        entries = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if isinstance(entries, list):
        return {str(e.get("id")): e for e in entries if isinstance(e, dict) and e.get("id")}
    return {}


# ---------------------------------------------------------------- main

def main() -> int:
    started = dt.datetime.now(dt.timezone.utc)
    print(f"visionlens release gate, started {started.isoformat(timespec='seconds')}")
    gate = Gate()
    with tempfile.TemporaryDirectory(prefix="visionlens-gate-") as scratch:
        tmp = Path(scratch)
        artifacts: tuple[Path, Path] | None = None
        try:
            artifacts = step_build(gate, tmp)
        except Exception as error:
            gate.record(Step("build", NOT_RUN, detail=str(error)))
        if artifacts is not None:
            wheel, sdist = artifacts
            step_artifact_scan(gate, wheel, sdist)
            step_clean_venv_install(gate, tmp, wheel, sdist)
            step_extras_resolution(gate, tmp, wheel)
        else:
            for name in ("artifact-scan", "clean-venv-install", "extras-resolution"):
                gate.record(Step(name, NOT_RUN, detail="no built artifacts"))
        step_records(gate)
        step_lock_compatibility(gate)
        step_dependency_scan(gate, tmp)

    finished = dt.datetime.now(dt.timezone.utc)
    GATE_DIR.mkdir(parents=True, exist_ok=True)
    report = {
        "startedAt": started.isoformat(timespec="seconds"),
        "finishedAt": finished.isoformat(timespec="seconds"),
        "gitSha": git_sha(),
        "environment": {
            "platform": platform.platform(),
            "python": sys.version.split()[0],
            "uv": (run(["uv", "--version"], timeout=30).stdout or "absent").strip(),
            "nodeOnPath": shutil.which("node") is not None,
        },
        "passed": gate.ok,
        "steps": [dataclasses.asdict(step) for step in gate.steps],
    }
    artifact_path = GATE_DIR / f"run-{started.strftime('%Y%m%dT%H%M%SZ')}.json"
    artifact_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print()
    print(f"steps: {sum(1 for s in gate.steps if s.status == PASS)} passed, "
          f"{sum(1 for s in gate.steps if s.status == FAIL)} failed, "
          f"{sum(1 for s in gate.steps if s.status == NOT_RUN)} not run")
    print(f"evidence artifact: {artifact_path}")
    return 0 if gate.ok else 1


if __name__ == "__main__":
    sys.exit(main())
