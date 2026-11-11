---
mode: ask
description: Diagnose and recover from a failed or partial Vision Lens run
---

You are diagnosing a failed or partial run of Vision Lens.

## Symptoms described

{{SYMPTOMS}}

## Diagnostic checklist

Work through the following steps systematically. For each step, show the command you ran
and the exact output before drawing conclusions.

### 1. Check for partial cache

```bash
ls -la output/.analysis_cache_partial.json 2>/dev/null && echo "PARTIAL CACHE EXISTS" || echo "no partial cache"
```

### 2. Check the main cache integrity

```bash
node -e "
try {
  const d = JSON.parse(require('fs').readFileSync('output/analysis_results.json', 'utf8'));
  console.log('schemaVersion:', d.schemaVersion);
  console.log('results count:', Object.keys(d.results ?? {}).length);
  console.log('processedFiles:', d.processedFiles?.length ?? 0);
} catch(e) { console.log('ERROR:', e.message); }
"
```

### 3. Check for interrupted atomic write

```bash
ls output/analysis_results.json.tmp 2>/dev/null && echo "TMP FILE EXISTS" || echo "no tmp file"
```

### 4. Count output files vs input files

```bash
echo "Input:" && ls input/*.{jpg,jpeg,png,heic,HEIC} 2>/dev/null | wc -l
echo "Output JPEGs:" && ls output/*.jpg 2>/dev/null | wc -l
```

## Recovery decision

Based on the diagnostic output:

| Finding                                         | Action                                                         |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `.analysis_cache_partial.json` is valid JSON    | Re-run with original flags — will resume automatically         |
| `.analysis_cache_partial.json` is corrupt       | Delete it, then re-run                                         |
| `analysis_results.json.tmp` exists              | Copy `.tmp` → `analysis_results.json`, validate, delete `.tmp` |
| `analysis_results.json` is corrupt/empty        | Delete it, re-run without `--skip-analysis`                    |
| Output count < input count but cache looks fine | Use `--skip-analysis` to re-run just the processing pass       |

## Safety rules before acting

- Always `cp <file> <file>.bak.$(date +%s)` before modifying or deleting any cache file
- Never delete `.analysis_cache_partial.json` unless you have confirmed it is unreadable
- Never delete `analysis_results.json` unless you have verified there is no backup and no partial cache to recover from

## After recovery

Verify completeness:

```bash
node -e "
const fs = require('fs');
const ins = fs.readdirSync('./input').filter(f => /\.(jpg|jpeg|png|heic)$/i.test(f)).length;
const res = Object.keys(JSON.parse(fs.readFileSync('./output/analysis_results.json','utf8')).results ?? {}).length;
console.log('Input:', ins, '| Results:', res, '|', ins === res ? 'COMPLETE' : 'INCOMPLETE — ' + (ins - res) + ' missing');
"
```
