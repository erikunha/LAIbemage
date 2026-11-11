#!/usr/bin/env python3
"""Classify a change into the 21 material domains and propose review tracks.

    python3 domain_matrix.py --base main --head HEAD --json
    python3 domain_matrix.py --diff-file /tmp/change.diff
    python3 domain_matrix.py --base main --head HEAD --repo /path/to/repo
    python3 domain_matrix.py --help

One job: read a change and report, per domain, whether it is MATERIAL,
SUPPORTING, NOT_APPLICABLE or UNKNOWN, why, which repository skill owns the
method when one exists, and the single falsifiable question the domain turns
into. It proposes the tracks; the reviewer decides and fills the completion
matrix, which starts as UNKNOWN here.

The rules are deterministic and declared in RULES below. A rule matches on a
path glob, a path segment, a file extension or a file name. No model, no
network, standard library only.

The domain list, the wave algorithm and the meaning of each classification
live in ../references/waves.md. The owner skill names are repository skills.

Exit codes:
  0 the matrix was produced
  2 invalid input (bad ref, unreadable diff file, missing arguments)
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys

SCHEMA = "self-review/domain-matrix/1"

MATERIAL = "MATERIAL"
SUPPORTING = "SUPPORTING"
NOT_APPLICABLE = "NOT_APPLICABLE"
UNKNOWN = "UNKNOWN"

COMPLETION_UNKNOWN = "UNKNOWN"

GIT_TIMEOUT = 30

# Domains that never go NOT_APPLICABLE on their own: the answer depends on
# something the path cannot settle.
OPEN_BY_DEFAULT = ("performance", "base_stacked_pr")

DOMAIN_ORDER = (
    "semantic_diff",
    "reachability",
    "precedent_history",
    "frontend",
    "client_state_url",
    "server_query_cache",
    "datatable_virtualization",
    "ui_design_system",
    "accessibility",
    "test_quality",
    "backend_api",
    "authorization_security",
    "codegen_sdk",
    "database_transaction",
    "migration_compatibility",
    "async_queues",
    "performance",
    "observability",
    "ai_llm",
    "ci_build",
    "base_stacked_pr",
)

# Each rule is (domain, level, reason, owner_skill, question, matcher).
# A matcher is a dict with any of: segments (path segment equals), globs (path
# matches), extensions (file suffix), names (base name matches). An empty
# matcher matches every changed file.
RULES = (
    {
        "domain": "semantic_diff",
        "level": MATERIAL,
        "segments": (),
        "globs": (),
        "extensions": (),
        "names": (),
        "reason": "the change carries behavior that a reader has to compare",
        "owner_skill": "code-reviewer",
        "question": "Which behavior does this change alter, what is observable before and after, and who consumes that difference?",
    },
    {
        "domain": "reachability",
        "level": MATERIAL,
        "segments": ("shared", "common", "libs", "packages", "core"),
        "globs": ("*/shared/*", "*/common/*", "*/libs/*", "*/packages/*", "*/core/*"),
        "extensions": (),
        "names": (),
        "reason": "a shared module or a manifest moves, so consumers outside the diff are in scope",
        "owner_skill": "monorepo-navigator",
        "question": "Which consumers outside the touched files depend on the changed surface, and does the change break any of them?",
    },
    {
        "domain": "precedent_history",
        "level": SUPPORTING,
        "segments": (),
        "globs": (),
        "extensions": (),
        "names": (),
        "reason": "the history of the touched files explains the constraints that are still in force",
        "owner_skill": "git-retro",
        "question": "What did the history of the touched files decide, and does that constraint still hold after this change?",
    },
    {
        "domain": "frontend",
        "level": MATERIAL,
        "segments": ("components", "pages", "app", "views", "routes-ui"),
        "globs": (),
        "extensions": (".tsx", ".jsx", ".vue", ".svelte"),
        "names": (),
        "reason": "a component or a render path changes",
        "owner_skill": "senior-nextjs",
        "question": "What does the changed surface render now, and which interaction or state path breaks with it?",
    },
    {
        "domain": "client_state_url",
        "level": MATERIAL,
        "segments": ("store", "stores", "state", "states", "context", "contexts",
                     "reducer", "reducers", "zustand", "redux", "router", "routing"),
        "globs": (),
        "extensions": (),
        "names": ("*store.*", "*state.*", "*context.*"),
        "reason": "client state or the URL becomes or stops being a source of truth",
        "owner_skill": "react-performance",
        "question": "Who owns this state after the change, and do the URL, the client store and the server agree on it?",
    },
    {
        "domain": "server_query_cache",
        "level": MATERIAL,
        "segments": ("query", "queries", "cache", "caches", "caching",
                     "queryclient", "react-query", "tanstack"),
        "globs": (),
        "extensions": (),
        "names": ("*querykey*", "*query-key*", "*queryKey*", "*useQuery*", "*cachekey*"),
        "reason": "a query key or a cache generation moves, so invalidation has to be checked",
        "owner_skill": "",
        "question": "Which cache generation does this key belong to, and does the invalidation reach every generation the same screen reads?",
    },
    {
        "domain": "datatable_virtualization",
        "level": MATERIAL,
        "segments": ("tables", "table", "datatable", "data-table", "virtual", "grid"),
        "globs": (),
        "extensions": (),
        "names": ("*table.*", "*datatable.*", "*virtual*"),
        "reason": "a table, a list or a virtualized surface changes, including its scroll ownership",
        "owner_skill": "",
        "question": "Which state does this view contribute to the query identity, and does changing that control change the rows the server returns?",
    },
    {
        "domain": "ui_design_system",
        "level": MATERIAL,
        "segments": ("ui", "design-system", "tokens", "theme", "themes", "primitives"),
        "globs": ("*/components/ui/*",),
        "extensions": (),
        "names": (),
        "reason": "a primitive, a token or a themed style changes",
        "owner_skill": "ui-design-system",
        "question": "Does the new surface use a primitive and a token that exist, and does the change keep the design contract?",
    },
    {
        "domain": "accessibility",
        "level": MATERIAL,
        "segments": (),
        "globs": (),
        "extensions": (".tsx", ".jsx", ".html", ".vue", ".svelte", ".css"),
        "names": (),
        "reason": "an interactive or styled surface changes, so name, role, state, keyboard and focus have to be rechecked",
        "owner_skill": "a11y-audit",
        "question": "What does the changed control expose to name, role, state, keyboard and focus?",
    },
    {
        "domain": "test_quality",
        "level": MATERIAL,
        "segments": ("tests", "test", "__tests__", "spec", "e2e", "fixtures"),
        "globs": (),
        "extensions": (".test.ts", ".test.tsx", ".test.js", ".spec.ts", ".spec.tsx", ".spec.js"),
        "names": ("*test.*", "*spec.*"),
        "reason": "a test, a fixture or a mock changes, so its protective value has to be checked",
        "owner_skill": "verification-planner",
        "question": "Which defect would this test fail on, and does its assertion observe that behavior or only its surroundings?",
    },
    {
        "domain": "backend_api",
        "level": MATERIAL,
        "segments": ("api", "apis", "routes", "controllers", "handlers", "endpoints",
                     "resolvers", "services", "server"),
        "globs": ("*/api/*",),
        "extensions": (),
        "names": (),
        "reason": "a route, a handler or a serialization changes",
        "owner_skill": "api-design-reviewer",
        "question": "What does this endpoint accept, validate and return now, and does the response still match the contract the clients parse?",
    },
    {
        "domain": "authorization_security",
        "level": MATERIAL,
        "segments": ("auth", "authz", "authorization", "permission", "permissions",
                     "rbac", "acl", "role", "roles", "session", "sessions", "token",
                     "tokens", "jwt", "oauth", "credential", "credentials", "secret",
                     "secrets", "crypto", "security", "policy", "policies", "guard",
                     "guards", "tenant", "tenants"),
        "globs": (),
        "extensions": (),
        "names": ("*auth*", "*permission*", "*policy*", "*guard*"),
        "reason": "an identity, a permission or a secret path changes",
        "owner_skill": "senior-security",
        "question": "Who can reach the changed resource, and what enforces that on the server rather than in the interface?",
    },
    {
        "domain": "codegen_sdk",
        "level": MATERIAL,
        "segments": ("generated", "codegen", "sdk", "openapi", "swagger", "proto",
                     "protos", "graphql"),
        "globs": (),
        "extensions": (),
        "names": ("*.gen.*", "*_pb2.*", "*generated*"),
        "reason": "a generated artifact or the step that generates it changes",
        "owner_skill": "strict-api",
        "question": "Is the artifact still the output of the current schema, and does the regeneration flow produce exactly these bytes?",
    },
    {
        "domain": "database_transaction",
        "level": MATERIAL,
        "segments": ("db", "database", "models", "model", "entities", "entity",
                     "repositories", "repository", "prisma", "drizzle", "typeorm",
                     "sequelize", "transactions", "sql"),
        "globs": (),
        "extensions": (".sql",),
        "exclude_globs": ("*/migrations/*", "migrations/*"),
        "names": ("schema.prisma",),
        "reason": "a model, a query or a transaction boundary changes",
        "owner_skill": "postgres-patterns",
        "question": "What is the atomic boundary of this write, and what happens to the external effect when the transaction rolls back?",
    },
    {
        "domain": "migration_compatibility",
        "level": MATERIAL,
        "segments": ("migrations", "migration", "alembic", "flyway", "liquibase"),
        "globs": ("*/migrations/*",),
        "extensions": (),
        "names": (),
        "reason": "a schema change lands, so both deploy orders have to hold",
        "owner_skill": "migration-architect",
        "question": "What does this schema change do to old code reading the old schema and to new code reading the new one, in both deploy orders?",
    },
    {
        "domain": "async_queues",
        "level": MATERIAL,
        "segments": ("queue", "queues", "worker", "workers", "job", "jobs", "bullmq",
                     "bull", "temporal", "workflows", "workflow", "activities",
                     "kafka", "rabbit", "sqs", "celery", "sidekiq", "pubsub",
                     "scheduler", "schedules", "cron"),
        "globs": (),
        "extensions": (),
        "names": ("*queue*", "*worker*", "*job*"),
        "reason": "a queue, a worker, a retry or a job identity changes",
        "owner_skill": "error-handling",
        "question": "Who retries this operation, where is the effect deduplicated, and what is the authoritative outcome after a repeated execution?",
    },
    {
        "domain": "performance",
        "level": MATERIAL,
        "segments": ("perf", "performance", "benchmarks", "benchmark"),
        "globs": (),
        "extensions": (),
        "names": ("*bench.*", "*perf.*"),
        "reason": "a measured hot path is named in the change",
        "unknown_reason": "no path names a hot path, and only a measurement settles whether performance is material here",
        "owner_skill": "performance-profiler",
        "question": "Which measured number changes here, and against which baseline is that a regression?",
    },
    {
        "domain": "observability",
        "level": MATERIAL,
        "segments": ("observability", "telemetry", "metrics", "metric", "tracing",
                     "trace", "logs", "logging", "instrumentation", "otel",
                     "opentelemetry", "sentry", "datadog"),
        "globs": (),
        "extensions": (),
        "names": (),
        "reason": "a signal, a log or a correlation id changes",
        "owner_skill": "observability-designer",
        "question": "When this fails in production, which signal shows it and what context carries the request identity?",
    },
    {
        "domain": "ai_llm",
        "level": MATERIAL,
        "segments": ("llm", "prompts", "prompt", "rag", "embeddings",
                     "inference", "completions", "evals", "eval", "model-routing"),
        "globs": (),
        "extensions": (),
        "names": ("*prompt*", "*embedding*", "*llm*"),
        "reason": "a prompt, a model route, a retrieval step or a tool call changes",
        "owner_skill": "claude-api",
        "question": "What does the model receive, what does it return, and which step validates that output before anything acts on it?",
    },
    {
        "domain": "ci_build",
        "level": MATERIAL,
        "segments": ("workflows", ".github", "ci", "build", "docker"),
        "globs": (".github/workflows/*", ".circleci/*", "*/.gitlab-ci.yml"),
        "extensions": (),
        "names": ("package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
                  "poetry.lock", "uv.lock", "Cargo.lock", "go.sum", "Dockerfile",
                  "Makefile", "tsconfig.json", "biome.json"),
        "reason": "the build, the pipeline or a dependency manifest changes",
        "owner_skill": "ci-cd-pipeline-builder",
        "question": "Does the workflow build and test what this change touched, with the same commands and the same environment the pipeline uses?",
    },
    {
        "domain": "base_stacked_pr",
        "level": UNKNOWN,
        "segments": (),
        "globs": (),
        "extensions": (),
        "names": (),
        "reason": "the comparison base is unresolved from a diff alone, and a stacked target needs it confirmed",
        "unknown_reason": "the comparison base is unresolved from a diff alone, and a stacked target needs it confirmed",
        "owner_skill": "pr-review-expert",
        "question": "Which base does this change target, and does the regression comparison use that base rather than the trunk?",
    },
)

DEPENDENCY_KEYS = ("dependencies", "devDependencies", "peerDependencies",
                   "optionalDependencies")

ADDED_DEPENDENCY_LINE = re.compile(r'^\+\s*"([^"]+)"\s*:\s*"([^"]+)"')


class UsageError(Exception):
    """An input problem caught before any work, worth exit code 2."""


def _matcher_matches(matcher, path):
    exclude = matcher.get("exclude_globs") or ()
    if exclude and any(fnmatch.fnmatch(path, glob) for glob in exclude):
        return False
    segments = set(re.split(r"[\\/]", path))
    if matcher.get("segments") and segments.intersection(matcher["segments"]):
        return True
    if matcher.get("globs") and any(fnmatch.fnmatch(path, glob) for glob in matcher["globs"]):
        return True
    if matcher.get("extensions"):
        name = os.path.basename(path).lower()
        for suffix in matcher["extensions"]:
            if name.endswith(suffix.lower()):
                return True
    if matcher.get("names"):
        base = os.path.basename(path)
        for pattern in matcher["names"]:
            if fnmatch.fnmatch(base, pattern):
                return True
    return not any(matcher.get(key) for key in ("segments", "globs", "extensions", "names"))


def _rule_matches(rule, path):
    return _matcher_matches(rule, path)


def git(repo, *args):
    try:
        result = subprocess.run(["git", "-C", repo, *args], capture_output=True,
                                text=True, timeout=GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as error:
        raise UsageError("git is not usable here: %s" % error)
    if result.returncode != 0:
        message = (result.stderr or result.stdout).strip().splitlines()
        detail = message[0] if message else "git exited %d" % result.returncode
        raise UsageError(detail)
    return result.stdout


def ref_exists(repo, ref):
    try:
        result = subprocess.run(["git", "-C", repo, "rev-parse", "--verify",
                                 "%s^{commit}" % ref], capture_output=True,
                                text=True, timeout=GIT_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as error:
        raise UsageError("git is not usable here: %s" % error)
    return result.returncode == 0


def changed_files_from_git(repo, base, head):
    if not ref_exists(repo, base):
        raise UsageError("base ref not found in %s: %s" % (repo, base))
    if not ref_exists(repo, head):
        raise UsageError("head ref not found in %s: %s" % (repo, head))
    output = git(repo, "diff", "--name-only", "--no-renames", "%s..%s" % (base, head))
    return [line.strip() for line in output.splitlines() if line.strip()]


def changed_files_from_diff(text):
    files = []
    seen = set()
    for line in text.splitlines():
        match = None
        if line.startswith("+++ "):
            target = line[4:].strip()
            if target.startswith("b/"):
                match = target[2:]
        elif line.startswith("diff --git "):
            parts = line.split(" ")
            if len(parts) >= 4:
                candidate = parts[3]
                match = candidate[2:] if candidate.startswith("b/") else candidate
        if match and match != "/dev/null" and match not in seen:
            seen.add(match)
            files.append(match)
    return files


def _dependency_sections(text):
    """Read the dependency names a diff adds, per dependency section."""
    sections = {}
    current = None
    for raw in text.splitlines():
        line = raw.rstrip()
        stripped = line.strip()
        if current is None:
            for key in DEPENDENCY_KEYS:
                if stripped.startswith('"%s"' % key):
                    current = key
                    sections[current] = set()
                    break
            continue
        if stripped.startswith("}"):
            current = None
            continue
        if not line.startswith("+") or line.startswith("+++"):
            continue
        match = ADDED_DEPENDENCY_LINE.match(line)
        if match:
            sections[current].add(match.group(1))
    return sections


def new_dependencies(repo, base, head, changed):
    """Return the dependencies added between base and head, when both exist."""
    if "package.json" not in changed:
        return {}
    added = {}
    for key in DEPENDENCY_KEYS:
        before = _package_section(repo, base, key)
        after = _package_section(repo, head, key)
        if before is None or after is None:
            continue
        difference = after - before
        if difference:
            added[key] = sorted(difference)
    return added


def _package_section(repo, ref, key):
    try:
        content = git(repo, "show", "%s:package.json" % ref)
    except UsageError:
        return None
    try:
        data = json.loads(content)
    except ValueError:
        return None
    section = data.get(key)
    if not isinstance(section, dict):
        return None
    return set(section.keys())


def new_dependencies_from_diff(text, changed):
    """Approximate the added dependencies from a diff file, when no refs exist."""
    if "package.json" not in changed:
        return {}
    added = {}
    for key, names in _dependency_sections(text).items():
        if names:
            added[key] = sorted(names)
    return added


def classify(changed, dependencies, rules=None):
    """Return one classification record per domain."""
    records = {}
    for domain in DOMAIN_ORDER:
        matched = [rule for rule in (rules or RULES) if rule["domain"] == domain]
        if any(rule.get("disabled") for rule in matched):
            records[domain] = {
                "domain": domain,
                "classification": NOT_APPLICABLE,
                "reason": "disabled by the rules file",
                "owner_skill": "",
                "question": "",
            }
            continue
        material = [rule for rule in matched
                    if rule["level"] == MATERIAL and any(_rule_matches(rule, path) for path in changed)]
        supporting = [rule for rule in matched
                      if rule["level"] == SUPPORTING and any(_rule_matches(rule, path) for path in changed)]
        rule = next((r for r in matched if r["domain"] == domain), None)
        if material:
            level = MATERIAL
            rule = material[0]
        elif supporting:
            level = SUPPORTING
            rule = supporting[0]
        elif domain in OPEN_BY_DEFAULT:
            level = UNKNOWN
        else:
            level = NOT_APPLICABLE
        if level == NOT_APPLICABLE:
            reason = "the change touches no file this domain reads"
        elif level == UNKNOWN:
            reason = (rule or {}).get("unknown_reason") or (rule or {}).get("reason", "")
        else:
            reason = rule["reason"] if rule else ""
        owner = rule["owner_skill"] if rule else ""
        question = rule["question"] if rule else ""
        if level == MATERIAL and domain == "ci_build" and dependencies:
            reason = reason + " (" + "; ".join(
                "%s adds %s" % (key, ", ".join(names)) for key, names in sorted(dependencies.items())) + ")"
        records[domain] = {
            "domain": domain,
            "classification": level,
            "reason": reason,
            "owner_skill": owner,
            "question": question,
        }
    return records


def build_tracks(records):
    tracks = []
    for domain in DOMAIN_ORDER:
        record = records[domain]
        if record["classification"] != MATERIAL:
            continue
        tracks.append({
            "id": "T%02d" % (len(tracks) + 1),
            "domain": domain,
            "question": record["question"],
            "owner_skill": record["owner_skill"] or None,
            "evidence_needed": "a decisive anchor from the proof anchor law",
        })
    return tracks


def build_completion():
    return [{"domain": domain, "state": COMPLETION_UNKNOWN} for domain in DOMAIN_ORDER]


def build_matrix(repo, base, head, diff_file, rules=None):
    dependencies = {}
    if diff_file:
        try:
            with open(diff_file, "r", encoding="utf-8", errors="replace") as handle:
                text = handle.read()
        except OSError as error:
            raise UsageError("cannot read diff file %s: %s" % (diff_file, error))
        changed = changed_files_from_diff(text)
        dependencies = new_dependencies_from_diff(text, changed)
    else:
        changed = changed_files_from_git(repo, base, head)
        dependencies = new_dependencies(repo, base, head, changed)
    changed.sort()
    records = classify(changed, dependencies, rules)
    return {
        "schema": SCHEMA,
        "base": base,
        "head": head,
        "repo": repo,
        "changed_files": changed,
        "dependencies_added": dependencies,
        "domains": [records[domain] for domain in DOMAIN_ORDER],
        "tracks": build_tracks(records),
        "completion": build_completion(),
    }


def render_text(matrix):
    lines = []
    lines.append("domain matrix (%s)" % matrix["schema"])
    if matrix["base"] and matrix["head"]:
        lines.append("range: %s..%s in %s" % (matrix["base"], matrix["head"], matrix["repo"]))
    lines.append("changed files: %d" % len(matrix["changed_files"]))
    for path in matrix["changed_files"]:
        lines.append("  %s" % path)
    lines.append("")
    lines.append("%-28s %-16s %s" % ("DOMAIN", "CLASSIFICATION", "REASON"))
    for record in matrix["domains"]:
        lines.append("%-28s %-16s %s" % (record["domain"], record["classification"], record["reason"]))
    lines.append("")
    lines.append("proposed tracks: %d" % len(matrix["tracks"]))
    for track in matrix["tracks"]:
        owner = track["owner_skill"] or "no owner skill in the repository"
        lines.append("  %s %s [%s]" % (track["id"], track["question"], owner))
    lines.append("")
    lines.append("completion matrix: every domain starts UNKNOWN, the reviewer fills it")
    for row in matrix["completion"]:
        lines.append("  %-28s %s" % (row["domain"], row["state"]))
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Classify a change into the material domains and propose review tracks.",
        epilog="The domain list and the completion vocabulary live in "
               "../references/waves.md. The completion matrix starts as UNKNOWN; "
               "the reviewer fills it.",
    )
    parser.add_argument("--base", help="base ref of the range")
    parser.add_argument("--head", help="head ref of the range")
    parser.add_argument("--diff-file", help="read the changed paths from a diff file instead of git")
    parser.add_argument("--repo", default=os.getcwd(), help="repository path (default: current)")
    parser.add_argument("--json", action="store_true", dest="as_json",
                        help="emit the matrix as JSON")
    parser.add_argument("--rules", help="optional JSON file with rule overrides")
    args = parser.parse_args()

    try:
        if args.diff_file:
            if args.base or args.head:
                raise UsageError("use either --diff-file or --base with --head, not both")
        else:
            if not args.base or not args.head:
                raise UsageError("--base and --head are required without --diff-file")
        rules = load_rule_overrides(args.rules) if args.rules else None
        matrix = build_matrix(args.repo, args.base, args.head, args.diff_file, rules)
    except UsageError as error:
        print("error: %s" % error, file=sys.stderr)
        return 2

    if args.as_json:
        print(json.dumps(matrix, indent=2))
    else:
        print(render_text(matrix))
    return 0


def load_rule_overrides(path):
    """Accept a JSON file that disables domains or replaces owner skills."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except OSError as error:
        raise UsageError("cannot read rules file %s: %s" % (path, error))
    except ValueError as error:
        raise UsageError("rules file %s is not valid JSON: %s" % (path, error))
    if not isinstance(data, dict):
        raise UsageError("rules file %s must hold a JSON object" % path)
    disabled = data.get("disable") or []
    owners = data.get("owner_skill") or {}
    if not isinstance(disabled, list) or not isinstance(owners, dict):
        raise UsageError("rules file %s: 'disable' must be a list and 'owner_skill' an object" % path)
    unknown = [name for name in list(disabled) + list(owners)
               if name not in DOMAIN_ORDER]
    if unknown:
        raise UsageError("rules file %s names unknown domains: %s"
                         % (path, ", ".join(sorted(set(unknown)))))
    effective = []
    for rule in RULES:
        copy = dict(rule)
        if copy["domain"] in disabled:
            copy["disabled"] = True
            copy["reason"] = "disabled by the rules file"
        if copy["domain"] in owners:
            copy["owner_skill"] = str(owners[copy["domain"]])
        effective.append(copy)
    return effective


if __name__ == "__main__":
    sys.exit(main())
