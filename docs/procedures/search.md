# Embed and search

Covers searching a classified image collection by keyword or by concept, setting up the
embedding index for the first time, and troubleshooting wrong or empty results (the embedding
model table, flags and diagnostics folded in from the former search command guide). Use it when
the collection must be queried, or the search index misbehaves.

## When to use

- Search a classified image collection by description or concept
- Set up the embedding index for the first time
- Troubleshoot search returning wrong or no results
- Understand the difference between keyword and semantic search

| Mode | When | Requirement |
| ---- | ---- | ----------- |
| Keyword search | Always available after any run | None; scans `shortDescription`, `fullDescription`, `elements`, `extractedText` |
| Semantic search | Higher recall for concept queries | Requires `--embed` to have been run |
| Hybrid (planned, H13) | Best recall overall | Requires the H13 SQLite index (see `ROADMAP.md`) |

## Step 1: determine which mode to recommend

- Does the user have an existing `analysis_results.json`? (If not, run the analysis first)
- Exact words (keyword) or concept/meaning (semantic)?
- Which provider? (It decides the embedding model available)

First-time users start with keyword search: zero setup, works immediately. Concept queries
("find photos that look like a kitchen") need the semantic setup.

## Step 2: keyword search (no setup)

```bash
vision-lens search --keyword "your term" --output ./output
vision-lens search --keyword "water damage" --output ./output --top 20
```

Fields searched: `shortDescription`, `fullDescription`, `elements`, `extractedText`. Ranked by
match count (BM25-like counting, not true BM25 yet). Case-insensitive. Literal substring match
only: no stemming yet.

## Step 3: semantic search (requires the embedding step)

```bash
# Step 1: generate embeddings (one-time)
vision-lens --input ./photos --output ./output --skip-analysis --embed

# Step 2: search
vision-lens search --query "your concept query" --output ./output
vision-lens search --query "kitchen with natural lighting" --output ./output --top 10
vision-lens search --query "water stains on ceiling" --output ./output --min-score 0.5
vision-lens search --query "red couch" --output ./output --output-format json
```

`--skip-analysis --embed` reads the existing `analysis_results.json` and generates embeddings
without re-running the LLM analysis; it writes `analysis_embeddings.index.json`. `--min-score`
(0 to 1, default 0.4) filters low-similarity results; `--top` (default 10) caps the result
count.

Embedding models per provider:

- `--provider openai`: `text-embedding-3-small` (1536 dims, $0.00002/1K tokens)
- `--provider google`: `text-embedding-004` (768 dims, free tier)
- `--provider ollama`: `nomic-embed-text` (768 dims, free/local)
- `--provider anthropic`: falls back to OpenAI when `OPENAI_API_KEY` is set, else errors

A user on Anthropic without an OpenAI key either adds `OPENAI_API_KEY` to `.env` (cheapest) or
switches embeddings to `--provider google` or `--provider ollama`.

## Step 4: regenerate the index when the analysis changes

If new images were analysed or the provider changed:

```bash
vision-lens --input ./photos --output ./output --skip-analysis --embed
```

Switching providers (e.g. openai to google) makes the old index incompatible: dimensions
differ. Re-run `--embed` with the new provider; the old index is replaced.

## Step 5: validate results and diagnose failures

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| Search returns nothing | Index missing or stale | Re-run `--skip-analysis --embed` |
| Provider mismatch error | Old index built with different provider dimensions | Re-run `--embed` with the current provider |
| Semantic search finds unrelated images | `fullDescription` empty or unhelpful | Re-run analysis with a better model; check `buildEmbeddingText()` in `packages/core/src/analyzer/embeddings.ts` |
| Keyword search misses obvious matches | Stemming/synonym gap | Keyword search is literal `.includes()`; use semantic search or expand the query |

## Step 6: advise on known limitations

- Keyword search is O(n) at >10K images; the H13 SQLite FTS5 index will fix this
- The index is rebuilt from scratch on every `--embed` run; incremental updates come in H14
- No metadata filters yet (`--filter-category`, `--filter-after`); coming in H13
- See `ROADMAP.md` H13 to H14 for the planned improvements

## Technical context

- Embedding vectors are stored in `analysis_embeddings.index.json` as JSON float64 arrays
- Cosine similarity via `cosineSimilarity()` in `packages/core/src/search/index.ts`
- `generateEmbeddings()` in `packages/core/src/analyzer/embeddings.ts` handles provider routing
- `searchSemantic()` and `searchKeyword()` in `packages/core/src/search/query.ts`
- `buildEmbeddingText()` builds: `"category: shortDescription. Elements: el1, el2. fullDescription"`
