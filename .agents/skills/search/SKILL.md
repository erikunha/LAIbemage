---
name: search
description: Use when a user wants to search their classified image collection by description or concept, set up the embedding index for the first time, or troubleshoot semantic and keyword search returning wrong or no results.
---

# Skill: Embed and Search

**Domain:** Setting up and using the semantic/keyword search engine

## When to use this skill

Use when a user wants to:
- Search their classified image collection by description or concept
- Set up the embedding index for the first time
- Troubleshoot search returning wrong or no results
- Understand the difference between keyword and semantic search

## Steps

### 1. Determine which search mode to recommend

Ask the user:
- Do they have an existing `analysis_results.json`? (If not, run analysis first)
- Do they want to search by exact words (keyword) or by concept/meaning (semantic)?
- Which provider are they using? (Affects embedding model available)

For **first-time users**: start with keyword search — zero setup, works immediately.
For **concept queries** ("find photos that look like a kitchen"): guide to semantic setup.

### 2. Keyword search — no setup required

```bash
vision-lens search --keyword "your term" --output ./output
```

Fields searched: `shortDescription`, `fullDescription`, `elements`, `extractedText`.
Ranked by match count. Case-insensitive. Literal substring match only (no stemming yet).

### 3. Semantic search — requires embedding step

```bash
# Step 1: generate embeddings (one-time)
vision-lens --input ./photos --output ./output --skip-analysis --embed

# Step 2: search
vision-lens search --query "your concept query" --output ./output
```

If the user is on Anthropic without an OpenAI key:
- Either add `OPENAI_API_KEY` to `.env` (cheapest embedding option)
- Or switch embedding to `--provider google` (free tier) or `--provider ollama` (local, free)

### 4. Validate results

Check for common failure modes:
- **Empty results**: index file missing → re-run `--embed`
- **Wrong results**: check `fullDescription` field is populated in `analysis_results.json`
- **Provider mismatch error**: old index built with different provider dimensions → re-run `--embed`

### 5. Advise on known limitations

Tell the user:
- Keyword search is O(n) at >10K images — H13 (SQLite FTS5) will fix this
- Index is rebuilt from scratch on every `--embed` run — incremental updates coming in H14
- No metadata filters yet (`--filter-category`, etc.) — coming in H13
- See ROADMAP.md H13–H14 for the planned improvements

## Technical context (for implementation questions)

- Embedding vectors stored in `analysis_embeddings.index.json` as JSON float64 arrays
- Cosine similarity via `cosineSimilarity()` in `packages/core/src/search/index.ts`
- `generateEmbeddings()` in `packages/core/src/analyzer/embeddings.ts` handles provider routing
- `searchSemantic()` and `searchKeyword()` in `packages/core/src/search/query.ts`
- `buildEmbeddingText()` builds: `"category: shortDescription. Elements: el1, el2. fullDescription"`
