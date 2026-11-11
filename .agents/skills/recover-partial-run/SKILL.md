---
name: recover-partial-run
description: Use when a Vision Lens run was interrupted by Ctrl-C, an OOM kill, a network failure or power loss, and the run must be resumed without losing already-processed images or re-paying for already-analysed images.
---

# Skill: Recover a Partial or Failed Run

## When to use this skill

Use when a run was interrupted (Ctrl-C, OOM, network failure, power loss) and you need to
resume it safely without losing already-processed images or re-paying for already-analysed images.

---

## Steps

### Step 1 — Assess the damage

Run these diagnostics in order:

```bash
# 1. Is there a partial cache?
ls -la output/.analysis_cache_partial.json 2>/dev/null && echo "PARTIAL CACHE FOUND" || echo "no partial cache"

# 2. How many images were already analysed?
node -e "
const fs = require('fs');
try {
  const d = JSON.parse(fs.readFileSync('output/analysis_results.json', 'utf8'));
  console.log('results:', Object.keys(d.results ?? {}).length);
  console.log('processedFiles:', d.processedFiles?.length ?? 0);
  console.log('schemaVersion:', d.schemaVersion);
} catch(e) { console.log('analysis_results.json unreadable:', e.message); }
"

# 3. How many output files exist?
ls output/*.jpg 2>/dev/null | wc -l

# 4. Is there an incomplete atomic write?
ls output/analysis_results.json.tmp 2>/dev/null && echo "INCOMPLETE TMP WRITE FOUND"
```

### Step 2 — Classify the scenario

| What you found                                    | Scenario                 | Go to   |
| ------------------------------------------------- | ------------------------ | ------- |
| `.analysis_cache_partial.json` exists, valid JSON | Normal partial cache     | Step 3A |
| `.analysis_cache_partial.json` is corrupt/empty   | Corrupt partial cache    | Step 3B |
| `analysis_results.json.tmp` exists                | Interrupted atomic write | Step 3C |
| `analysis_results.json` is empty/corrupt          | Corrupt final cache      | Step 3D |
| Everything looks fine but some images are missing | Sequence gap             | Step 3E |

### Step 3A — Normal partial cache → just re-run

The tool detects `.analysis_cache_partial.json` automatically on startup and resumes:

```bash
node dist/cli/index.js --input ./input --output ./output [original flags]
```

Watch for `[cache] Resuming from partial cache — N images already analysed` in the output.

### Step 3B — Corrupt partial cache → back up and delete

```bash
cp output/.analysis_cache_partial.json output/.analysis_cache_partial.json.bak.$(date +%s)
rm output/.analysis_cache_partial.json
node dist/cli/index.js --input ./input --output ./output [original flags]
```

Already-written output JPEGs are not affected — the analysis will re-classify the same images
but skip writing output files that already exist (if using `--no-overwrite`).

### Step 3C — Interrupted atomic write → recover the tmp file

```bash
cp output/analysis_results.json output/analysis_results.json.bak.$(date +%s) 2>/dev/null
cp output/analysis_results.json.tmp output/analysis_results.json
# Validate
node -e "JSON.parse(require('fs').readFileSync('output/analysis_results.json','utf8')); console.log('VALID')"
rm output/analysis_results.json.tmp
```

### Step 3D — Corrupt final cache → start over

```bash
cp output/analysis_results.json output/analysis_results.json.bak.$(date +%s) 2>/dev/null
rm output/analysis_results.json
node dist/cli/index.js --input ./input --output ./output [original flags]
```

This will re-analyse everything. LLM API costs will be incurred again for the full input set.

### Step 3E — Sequence number gap → delete and re-run

Sequence numbers are assigned by the classifier at sort time — they cannot be patched.
The only safe fix is to clear the output and re-run:

```bash
cp -r output/ output.bak.$(date +%s)/
rm output/*.jpg output/analysis_results.json 2>/dev/null
node dist/cli/index.js --input ./input --output ./output [original flags]
```

### Step 4 — Verify the recovered run

After re-running:

```bash
# Check all input images appear in results
node -e "
const fs = require('fs');
const path = require('path');
const inputs = fs.readdirSync('./input').filter(f => /\.(jpg|jpeg|png|heic)$/i.test(f));
const results = JSON.parse(fs.readFileSync('./output/analysis_results.json', 'utf8'));
const covered = new Set(Object.keys(results.results ?? {}));
const missing = inputs.filter(f => !covered.has(f));
console.log('Inputs:', inputs.length, '| Results:', covered.size, '| Missing:', missing.length);
if (missing.length) console.log('Missing:', missing.slice(0, 5));
"
```

### Step 5 — Prevent future interruptions

- Use `--concurrency 1` if memory pressure caused the OOM kill
- Run in a `tmux` or `screen` session to survive network disconnects
- Consider running with `--skip-analysis` after a confirmed full analysis to re-process only
