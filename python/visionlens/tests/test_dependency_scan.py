"""The dependency scan reads the findings pip-audit reports, and sizes them.

The scan is the gate's only view of the advisory world, and it has to be
exact: a finding pip-audit reports and the gate does not see is a finding the
gate cannot block, which is a silent pass. The report shape below is the one
pip-audit emits (the findings live under `vulns`, and the report carries no
severity), captured from a real run against a known vulnerable release.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any

import pytest

GATE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "release_gate.py"


def _load_gate() -> Any:
    """The release gate script, loaded as a module."""
    spec = importlib.util.spec_from_file_location("release_gate_under_test", GATE_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


gate = _load_gate()


# The report pip-audit writes: the findings live under `vulns`, and no
# severity is present anywhere in the payload.
PIP_AUDIT_REPORT: dict[str, Any] = {
    "dependencies": [
        {
            "name": "urllib3",
            "version": "1.26.5",
            "vulns": [
                {
                    "id": "PYSEC-2026-1995",
                    "fix_versions": ["1.26.19", "2.2.2"],
                    "aliases": ["GHSA-34jh-p97f-mpxf", "CVE-2024-37891"],
                    "description": "Proxy-Authorization header leak.",
                }
            ],
        }
    ],
    "fixes": [],
}


def test_the_findings_pip_audit_reports_are_read() -> None:
    """The scan must read the key pip-audit actually writes."""
    collected = gate.collect_findings(PIP_AUDIT_REPORT, lambda vulnerability: "medium")

    assert len(collected) == 1
    finding = collected[0]
    assert finding["package"] == "urllib3"
    assert finding["version"] == "1.26.5"
    assert finding["id"] == "PYSEC-2026-1995"
    assert finding["severity"] == "medium"
    assert finding["aliases"] == ["GHSA-34jh-p97f-mpxf", "CVE-2024-37891"]
    assert finding["fixVersions"] == ["1.26.19", "2.2.2"]


def test_a_clean_report_yields_no_finding() -> None:
    report = {"dependencies": [{"name": "pydantic", "version": "2.14.3", "vulns": []}], "fixes": []}

    assert gate.collect_findings(report, lambda vulnerability: "high") == []


def test_a_finding_pip_audit_repeats_is_recorded_once() -> None:
    """pip-audit lists a vulnerability once per affected range."""
    report = {
        "dependencies": [
            {
                "name": "urllib3",
                "version": "1.26.5",
                "vulns": [
                    {"id": "PYSEC-2023-192", "fix_versions": ["1.26.17"], "aliases": []},
                    {"id": "PYSEC-2023-192", "fix_versions": ["2.0.6"], "aliases": []},
                ],
            }
        ]
    }

    collected = gate.collect_findings(report, lambda vulnerability: "high")

    assert len(collected) == 1
    assert collected[0]["id"] == "PYSEC-2023-192"
    assert collected[0]["fixVersions"] == ["1.26.17", "2.0.6"]
    assert collected[0]["severity"] == "high"


def test_the_other_key_is_accepted_too() -> None:
    """A report from another producer is read, not silently reported as empty."""
    report = {
        "dependencies": [
            {
                "name": "urllib3",
                "version": "1.26.5",
                "vulnerabilities": [{"id": "CVE-2024-37891", "severity": "high"}],
            }
        ]
    }

    collected = gate.collect_findings(report, lambda vulnerability: "high")

    assert [finding["id"] for finding in collected] == ["CVE-2024-37891"]


def test_the_advisory_label_sizes_the_finding() -> None:
    payload = {"database_specific": {"severity": "MODERATE"}}

    assert gate.severity_from_osv(payload) == "medium"


def test_the_ecosystem_label_sizes_the_finding() -> None:
    payload = {"affected": [{"ecosystem_specific": {"severity": "HIGH"}}]}

    assert gate.severity_from_osv(payload) == "high"


def test_the_cvss_vector_sizes_the_finding_when_no_label_exists() -> None:
    payload = {
        "severity": [
            {"type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:H/I:N/A:N"}
        ]
    }

    assert gate.severity_from_osv(payload) == "medium"


def test_an_advisory_without_any_severity_is_unsized() -> None:
    assert gate.severity_from_osv({"id": "PYSEC-2026-1995"}) is None


@pytest.mark.parametrize(
    ("vector", "expected"),
    [
        ("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8),
        ("CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:U/C:H/I:N/A:N", 4.4),
        ("CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N", 5.5),
        ("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10.0),
        # The scope-changed and the adjacent-attack-vector weights: the two
        # paths the vectors above do not reach.
        ("CVSS:3.1/AV:P/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H", 7.4),
        ("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H", 9.9),
        ("CVSS:3.1/AV:P/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 6.8),
    ],
)
def test_the_cvss_base_score_matches_the_published_values(vector: str, expected: float) -> None:
    """The scores are the ones the reference implementation produces."""
    assert gate.cvss_base_score(vector) == pytest.approx(expected)


def test_an_unreadable_vector_has_no_score() -> None:
    assert gate.cvss_base_score("not-a-vector") is None
    assert gate.cvss_base_score("CVSS:3.1/AV:N/AC:L") is None


@pytest.mark.parametrize(
    ("score", "band"),
    [
        (0.0, "none"),
        (3.9, "low"),
        (4.0, "medium"),
        (6.9, "medium"),
        (7.0, "high"),
        (8.9, "high"),
        (9.0, "critical"),
        (10.0, "critical"),
    ],
)
def test_the_score_bands_are_the_published_ones(score: float, band: str) -> None:
    assert gate.severity_band(score) == band


def test_the_severity_is_read_from_the_advisory_and_its_aliases(monkeypatch: Any) -> None:
    seen: list[str] = []

    def fake_osv(identifier: str) -> str | None:
        seen.append(identifier)
        return {"GHSA-34jh-p97f-mpxf": "medium"}.get(identifier)

    monkeypatch.setattr(gate, "osv_severity", fake_osv)
    vulnerability = PIP_AUDIT_REPORT["dependencies"][0]["vulns"][0]

    severity = gate.finding_severity(vulnerability, {})

    assert severity == "medium"
    assert seen == ["PYSEC-2026-1995", "GHSA-34jh-p97f-mpxf"]


def test_a_finding_no_authority_could_size_stays_unspecified(monkeypatch: Any) -> None:
    monkeypatch.setattr(gate, "osv_severity", lambda identifier: None)
    vulnerability = PIP_AUDIT_REPORT["dependencies"][0]["vulns"][0]

    assert gate.finding_severity(vulnerability, {}) == "unspecified"


def test_an_unreviewed_high_finding_blocks_the_gate() -> None:
    collected = gate.collect_findings(
        PIP_AUDIT_REPORT, lambda vulnerability: "high"
    )

    blocking = gate.blocking_findings(collected, {})

    assert len(blocking) == 1
    assert "PYSEC-2026-1995" in blocking[0]
    assert "severity=high" in blocking[0]


def test_an_unreviewed_critical_finding_blocks_the_gate() -> None:
    collected = gate.collect_findings(PIP_AUDIT_REPORT, lambda vulnerability: "critical")

    assert gate.blocking_findings(collected, {})


def test_an_unsized_finding_blocks_the_gate() -> None:
    """A finding no authority could size is an unreviewed one, so it blocks."""
    collected = gate.collect_findings(
        PIP_AUDIT_REPORT, lambda vulnerability: "unspecified"
    )

    blocking = gate.blocking_findings(collected, {})

    assert len(blocking) == 1
    assert "no severity reported" in blocking[0]


def test_a_reviewed_finding_does_not_block() -> None:
    collected = gate.collect_findings(PIP_AUDIT_REPORT, lambda vulnerability: "high")
    reviewed = {"PYSEC-2026-1995": {"id": "PYSEC-2026-1995", "note": "fixed upstream"}}

    assert gate.blocking_findings(collected, reviewed) == []


def test_a_medium_finding_does_not_block() -> None:
    collected = gate.collect_findings(PIP_AUDIT_REPORT, lambda vulnerability: "medium")

    assert gate.blocking_findings(collected, {}) == []


def test_the_severity_of_one_advisory_is_looked_up_once(monkeypatch: Any) -> None:
    calls: list[str] = []

    def fake_osv(identifier: str) -> str | None:
        calls.append(identifier)
        return "high"

    monkeypatch.setattr(gate, "osv_severity", fake_osv)
    cache: dict[str, str | None] = {}
    vulnerability = PIP_AUDIT_REPORT["dependencies"][0]["vulns"][0]

    first = gate.finding_severity(vulnerability, cache)
    second = gate.finding_severity(vulnerability, cache)

    assert first == second == "high"
    assert calls == ["PYSEC-2026-1995"]
