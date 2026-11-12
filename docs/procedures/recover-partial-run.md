# Recover a partial or failed run

Covers resuming a run that was interrupted (Ctrl-C, OOM kill, network failure, power loss)
without losing already-processed images or re-paying for already-analysed images. It starts
from the cache write invariants that make recovery possible at all (those invariants folded in
from the former quality-gate checklist). Use it after any interrupted or partially complete run.

## Cache write invariants

Recovery works because the run obeys these invariants while writing; a change that breaks one
of them breaks recovery too:

- The final cache write is atomic: `writeJSON` to `analysis_results.json.tmp`, then
  `rename(tmp, final)`
- `flushPartialCache` wraps its `fs.writeJSON` in try/catch, so an interrupted flush leaves the
  previous partial cache intact
- `BatchEnvelopeSchema.safeParse()` guards every batch JSON parse
- Every `AnalysisCache` / `PartialAnalysisCache` literal includes `categoriesHash`
- Any change to the cache shape increments `CACHE_SCHEMA_VERSION` in
  `packages/core/src/types.ts` with a migration in `packages/core/src/store/migrate.ts`

## Step 1: assess the damage

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

## Step 2: classify the scenario

| What you found                                    | Scenario                 | Go to    |
| ------------------------------------------------- | ------------------------ | -------- |
| `.analysis_cache_partial.json` exists, valid JSON | Normal partial cache     | Step 3A  |
| `.analysis_cache_partial.json` is corrupt/empty   | Corrupt partial cache    | Step 3B  |
| `analysis_results.json.tmp` exists                | Interrupted atomic write | Step 3C  |
| `analysis_results.json` is empty/corrupt          | Corrupt final cache      | Step 3D  |
| Everything looks fine but some images are missing | Sequence gap             | Step 3E  |

## Step 3A: normal partial cache, just re-run

The tool detects `.analysis_cache_partial.json` automatically on startup and resumes:

```bash
node dist/cli/index.js --input ./input --output ./output [original flags]
```

Watch for the `[cache] Resuming from partial cache` log line in the output; it names how many
images were already analysed.

## Step 3B: corrupt partial cache, back up and delete

```bash
cp output/.analysis_cache_partial.json output/.analysis_cache_partial.json.bak.$(date +%s)
rm output/.analysis_cache_partial.json
node dist/cli/index.js --input ./input --output ./output [original flags]
```

Already-written output JPEGs are not affected: the analysis re-classifies the same images but
skips writing output files that already exist (when using `--no-overwrite`).

## Step 3C: interrupted atomic write, recover the tmp file

```bash
cp output/analysis_results.json output/analysis_results.json.bak.$(date +%s) 2>/dev/null
cp output/analysis_results.json.tmp output/analysis_results.json
# Validate
node -e "JSON.parse(require('fs').readFileSync('output/analysis_results.json','utf8')); console.log('VALID')"
rm output/analysis_results.json.tmp
```

## Step 3D: corrupt final cache, start over

```bash
cp output/analysis_results.json output/analysis_results.json.bak.$(date +%s) 2>/dev/null
rm output/analysis_results.json
node dist/cli/index.js --input ./input --output ./output [original flags]
```

This re-analyses everything; LLM API costs are incurred again for the full input set.

## Step 3E: sequence number gap, delete and re-run

Sequence numbers are assigned by the classifier at sort time; they cannot be patched. The only
safe fix is to clear the output and re-run:

```bash
cp -r output/ output.bak.$(date +%s)/
rm output/*.jpg output/analysis_results.json 2>/dev/null
node dist/cli/index.js --input ./input --output ./output [original flags]
```

## Step 4: verify the recovered run

```bash
node -e "
const fs = require('fs');
const inputs = fs.readdirSync('./input').filter(f => /\.(jpg|jpeg|png|heic)$/i.test(f));
const results = JSON.parse(fs.readFileSync('./output/analysis_results.json', 'utf8'));
const covered = new Set(Object.keys(results.results ?? {}));
const missing = inputs.filter(f => !covered.has(f));
console.log('Inputs:', inputs.length, '| Results:', covered.size, '| Missing:', missing.length);
if (missing.length) console.log('Missing:', missing.slice(0, 5));
"
```

## Step 5: prevent future interruptions

- Use `--concurrency 1` if memory pressure caused the OOM kill
- Run in a `tmux` or `screen` session to survive network disconnects
- Consider `--skip-analysis` after a confirmed full analysis to re-process only

## Safety rules

- Always `cp <file> <file>.bak.$(date +%s)` before modifying or deleting any cache file
- Never delete `.analysis_cache_partial.json` unless it is confirmed unreadable
- Never delete `analysis_results.json` without verifying there is no backup and no partial
  cache to recover from
