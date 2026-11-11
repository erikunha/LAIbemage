#!/usr/bin/env python3
"""Validate a findings file against the finding contract and the evidence law.

    python3 finding_check.py --findings findings.json
    python3 finding_check.py --findings findings.json --json
    python3 finding_check.py --help

One job: read a findings file and report, per finding, whether it carries what
a finding needs to survive review. A finding needs a location, the behavior
that happens, an evidence label, a proof anchor of one of the four accepted
kinds with its own content, a consequence and a certainty. Severity is
normalized onto the canonical ladder from the ladders this repository already
uses.

The vocabulary, the anchor law and the canonical ladder live in
../references/evidence.md.

Input is JSON: {"findings": [ {...}, ... ]}. A finding is an object with:

    location        "path:line" or a runtime flow description
    behavior        what happens, in one sentence
    evidence        {"label": "<one of the evidence labels>", "detail": "..."}
    proof_anchor    {"type": "COUNT|SIBLING|RUN|NORMATIVE", ...}
    consequence     what it costs when it happens
    certainty       "CONFIRMED|PROBABLE|SPECULATIVE"
    severity        any severity this repository uses, or a canonical one

Anchors carry their own content: COUNT needs a denominator, SIBLING needs
file:line, RUN needs a command and a result, NORMATIVE needs the clause.

Exit codes:
  0 every finding is valid
  1 at least one finding is invalid
  2 malformed input
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys

SCHEMA = "self-review/finding-check/1"

# The evidence vocabulary, from ../references/evidence.md.
EVIDENCE_LABELS = (
    "SOURCE_CONFIRMED",
    "DOC_CONFIRMED",
    "COUNTED",
    "STATIC_CONFIRMED",
    "TEST_CONFIRMED",
    "RUNTIME_OBSERVED",
    "BROWSER_OBSERVED",
    "NETWORK_OBSERVED",
    "PERSISTENCE_OBSERVED",
    "PERFORMANCE_MEASURED",
    "BASELINE_COMPARED",
    "UPSTREAM_CONFIRMED",
    "INFERRED",
    "UNKNOWN",
    "BLOCKED",
)

OBSERVATION_LABELS = frozenset(label for label in EVIDENCE_LABELS
                               if label not in ("INFERRED", "UNKNOWN", "BLOCKED"))

ANCHOR_TYPES = ("COUNT", "SIBLING", "RUN", "NORMATIVE")

CERTAINTY_VALUES = ("CONFIRMED", "PROBABLE", "SPECULATIVE")

# The canonical ladder, and the ladders this repository already uses, mapped
# onto it. The first mapping is the canonical one itself.
SEVERITY_LADDERS = (
    ("canonical", {
        "BLOCKER": "BLOCKER",
        "MAJOR": "MAJOR",
        "CONSIDER": "CONSIDER",
        "QUESTION": "QUESTION",
    }),
    ("runtime/quality/review_loop.py", {
        "BLOCKER": "BLOCKER",
        "MAJOR": "MAJOR",
        "MINOR": "CONSIDER",
        "NIT": "CONSIDER",
    }),
    ("library/engineering/engineering-skills/skills/adversarial-reviewer", {
        "CRITICAL": "BLOCKER",
        "WARNING": "MAJOR",
        "NOTE": "CONSIDER",
    }),
    ("library/engineering/engineering-advanced-skills/skills/pr-review-expert", {
        "MUST FIX": "MAJOR",
        "SHOULD FIX": "CONSIDER",
        "SUGGESTIONS": "CONSIDER",
    }),
)

# The severity a finding carries when its own severity names none of the
# ladders above.
SEVERITY_SOURCES_DOC = (
    "severity may come from the canonical ladder, from "
    "runtime/quality/review_loop.py, from the adversarial reviewer or from "
    "the pull request review expert"
)

HIGH_SEVERITIES = ("BLOCKER", "MAJOR")

FILE_LINE = re.compile(r"^[^\s:]+\.[A-Za-z0-9]+:\d+$")
COMMAND = re.compile(r"^[\w./-]+")


class UsageError(Exception):
    """Malformed input, worth exit code 2."""


def canonical_severity(value):
    """Return (canonical, source) for a severity string, or (None, None)."""
    if not isinstance(value, str):
        return None, None
    cleaned = " ".join(value.split()).upper()
    for name, mapping in SEVERITY_LADDERS:
        for source, canonical in mapping.items():
            if cleaned == source.upper():
                return canonical, name
    return None, None


def _text(value):
    return value.strip() if isinstance(value, str) else ""


def check_anchor(anchor):
    """Return the problems of a proof anchor."""
    problems = []
    if not isinstance(anchor, dict):
        return ["proof_anchor is missing or is not an object"]
    kind = _text(anchor.get("type")).upper()
    if not kind:
        problems.append("proof_anchor has no type")
        return problems
    if kind not in ANCHOR_TYPES:
        problems.append("proof_anchor type %r is not one of %s" % (kind, ", ".join(ANCHOR_TYPES)))
        return problems
    if kind == "COUNT":
        denominator = anchor.get("denominator")
        count = anchor.get("count")
        if not isinstance(denominator, int) or isinstance(denominator, bool) or denominator <= 0:
            problems.append("a COUNT anchor needs a positive denominator")
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            problems.append("a COUNT anchor needs the count it measured")
    elif kind == "SIBLING":
        location = _text(anchor.get("location"))
        if not location:
            problems.append("a SIBLING anchor needs the location of the equivalent implementation")
        elif not FILE_LINE.match(location):
            problems.append("a SIBLING anchor needs file:line, got %r" % location)
    elif kind == "RUN":
        command = _text(anchor.get("command"))
        result = _text(anchor.get("result"))
        if not command:
            problems.append("a RUN anchor needs the command that was run")
        elif not COMMAND.match(command.split()[0]):
            problems.append("a RUN anchor needs the command that was run, got %r" % command)
        if not result:
            problems.append("a RUN anchor needs the result that command produced")
    elif kind == "NORMATIVE":
        clause = _text(anchor.get("clause"))
        if not clause:
            problems.append("a NORMATIVE anchor needs the exact clause of the contract")
    return problems


def check_finding(finding):
    """Return the problems of one finding and its normalized form."""
    problems = []
    if not isinstance(finding, dict):
        return ["the finding is not an object"], {}

    location = _text(finding.get("location"))
    if not location:
        problems.append("no location: the finding does not say where it happens")

    behavior = _text(finding.get("behavior"))
    if not behavior:
        problems.append("no behavior: the finding does not say what happens")

    evidence = finding.get("evidence")
    label = ""
    if not isinstance(evidence, dict):
        problems.append("no evidence label: the finding does not say how it was established")
    else:
        label = _text(evidence.get("label")).upper()
        if not label:
            problems.append("no evidence label: the finding does not say how it was established")
        elif label not in EVIDENCE_LABELS:
            problems.append("evidence label %r is not in the vocabulary" % label)

    anchor_problems = check_anchor(finding.get("proof_anchor"))
    problems.extend(anchor_problems)

    consequence = _text(finding.get("consequence"))
    if not consequence:
        problems.append("no consequence: the finding does not say what it costs")

    certainty = _text(finding.get("certainty")).upper()
    if not certainty:
        problems.append("no certainty: the finding does not say how sure it is")
    elif certainty not in CERTAINTY_VALUES:
        problems.append("certainty %r is not one of %s" % (certainty, ", ".join(CERTAINTY_VALUES)))

    severity, severity_source = canonical_severity(finding.get("severity"))
    if severity is None:
        problems.append("severity %r is not on any ladder this repository uses (%s)"
                        % (finding.get("severity"), SEVERITY_SOURCES_DOC))

    if label == "INFERRED" and severity in HIGH_SEVERITIES:
        problems.append("an inference cannot carry %s: uncertainty does not raise the severity" % severity)
    if certainty == "SPECULATIVE" and severity in HIGH_SEVERITIES:
        problems.append("a speculative finding cannot carry %s: uncertainty does not raise the severity" % severity)
    if label in ("UNKNOWN", "BLOCKED") and severity in HIGH_SEVERITIES:
        problems.append("a finding labeled %s cannot carry %s" % (label, severity))

    normalized = {
        "location": location,
        "evidence_label": label,
        "evidence_kind": "observation" if label in OBSERVATION_LABELS else "not_an_observation",
        "proof_anchor_type": _text(finding.get("proof_anchor", {}).get("type")).upper()
        if isinstance(finding.get("proof_anchor"), dict) else "",
        "severity": severity,
        "severity_source": severity_source,
        "certainty": certainty,
        "domain": _text(finding.get("domain")),
    }
    return problems, normalized


def load_findings(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as error:
        raise UsageError("cannot read %s: %s" % (path, error))
    except ValueError as error:
        raise UsageError("%s is not valid JSON: %s" % (path, error))
    if not isinstance(data, dict) or not isinstance(data.get("findings"), list):
        raise UsageError("%s must hold an object with a 'findings' list" % path)
    return data["findings"]


def check_all(findings):
    rows = []
    valid = 0
    for index, finding in enumerate(findings):
        problems, normalized = check_finding(finding)
        if problems:
            rows.append({"index": index, "valid": False, "problems": problems, "normalized": normalized})
        else:
            valid += 1
            rows.append({"index": index, "valid": True, "problems": [], "normalized": normalized})
    return {
        "schema": SCHEMA,
        "total": len(findings),
        "valid": valid,
        "invalid": len(findings) - valid,
        "findings": rows,
    }


def render_text(report):
    lines = []
    lines.append("finding check (%s)" % report["schema"])
    lines.append("findings: %d, valid: %d, invalid: %d"
                 % (report["total"], report["valid"], report["invalid"]))
    for row in report["findings"]:
        marker = "ok  " if row["valid"] else "BAD "
        lines.append("%s#%d %s" % (marker, row["index"], row["normalized"].get("location", "")))
        for problem in row["problems"]:
            lines.append("      %s" % problem)
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Validate a findings file against the finding contract and the evidence law.",
        epilog="The vocabulary, the anchor law and the canonical severity ladder "
               "live in ../references/evidence.md.",
    )
    parser.add_argument("--findings", required=True, help="path to the findings JSON file")
    parser.add_argument("--json", action="store_true", dest="as_json",
                        help="emit the report as JSON")
    args = parser.parse_args()

    try:
        findings = load_findings(args.findings)
        report = check_all(findings)
    except UsageError as error:
        print("error: %s" % error, file=sys.stderr)
        return 2

    if args.as_json:
        print(json.dumps(report, indent=2))
    else:
        print(render_text(report))
    return 0 if report["invalid"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
