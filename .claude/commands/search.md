# Embed and Search

Set up semantic or keyword search on a classified image collection.

**Query:** $ARGUMENTS (e.g. "kitchen with natural light" or "--keyword crack")

## When to use what

| Mode | When | Requirement |
|---|---|---|
| Keyword search | Always available after any run | None — scans shortDescription, fullDescription, elements, extractedText |
| Semantic search | Higher recall for concept queries | Requires `--embed` to have been run |
| Hybrid (H13, planned) | Best recall overall | Requires H13 SQLite index |

## Step 1 — Run keyword search (no setup)

```bash
vision-lens search --keyword "crack" --output ./output
vision-lens search --keyword "water damage" --output ./output --top 20
```

Keyword search scans four fields: `shortDescription`, `fullDescription`, `elements`, `extractedText`.
Ranks by number of field matches (BM25-like counting, not true BM25 yet — see H13 in ROADMAP.md).

## Step 2 — Generate embeddings (one-time, required for semantic search)

```bash
vision-lens --input ./photos --output ./output --skip-analysis --embed
```

`--skip-analysis --embed` reads the existing `analysis_results.json` and generates embeddings without re-running the LLM analysis. Writes `analysis_embeddings.index.json`.

Embedding models used per provider:
- `--provider openai`: `text-embedding-3-small` (1536 dims, $0.00002/1K tokens)
- `--provider google`: `text-embedding-004` (768 dims, ~free tier)
- `--provider ollama`: `nomic-embed-text` (768 dims, free/local)
- `--provider anthropic`: falls back to OpenAI if `OPENAI_API_KEY` is set, else errors

## Step 3 — Run semantic search

```bash
vision-lens search --query "kitchen with natural lighting" --output ./output --top 10
vision-lens search --query "water stains on ceiling" --output ./output --min-score 0.5
vision-lens search --query "red couch" --output ./output --output-format json
```

`--min-score` (0–1, default 0.4): filter out low-similarity results.
`--top` (default 10): maximum results to return.

## Step 4 — Regenerate index when analysis changes

If new images are analyzed or the provider changes:
```bash
# Re-run embeddings with skip-analysis to avoid re-analyzing everything
vision-lens --input ./photos --output ./output --skip-analysis --embed
```

**Important:** If you switch providers (e.g. openai → google), the index has incompatible dimensions.
Re-run `--embed` with the new provider — the old index will be replaced.

## Diagnosing bad results

| Symptom | Cause | Fix |
|---|---|---|
| Search returns nothing | Index missing or stale | Re-run `--skip-analysis --embed` |
| Wrong provider mismatch error | Old index is different dimension than new query | Re-run `--embed` with current provider |
| Semantic search finds unrelated images | `fullDescription` is empty or unhelpful | Re-run analysis with a better model; check `buildEmbeddingText()` in `src/analyzer/embeddings.ts` |
| Keyword search misses obvious matches | Stemming/synonym gap | Keyword search is literal `.includes()` — use semantic search instead, or try expanding the query |

## Current limitations (see H13 in ROADMAP.md)

- Keyword search is O(n) full scan — no inverted index. Slow at >10K images.
- Semantic index loaded from JSON on every query — no caching.
- No hybrid mode yet (keyword + semantic combined). Coming in H13.
- No metadata filters yet (`--filter-category`, `--filter-after`). Coming in H13.
