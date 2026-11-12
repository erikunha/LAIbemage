# Vision Lens Studio — information architecture and UI implementation

## Routes and screens

| Route (proposal) | Primary job | Interactions |
|---|---|---|
| `/` | onboarding, demo selector, recent datasets | local vs remote connection, capability test |
| `/datasets` | compare datasets | filters, quality badges, virtualized grids |
| `/datasets/:id` | inspect versions and provenance | manifest, source/license, split chart, versions |
| `/datasets/:id/explore` | visual search and hard-case discovery | embeddings, filters, nearest neighbor, clusters |
| `/datasets/:id/annotate` | review labels | keyboard workflow, undo, approve/reject, masks later |
| `/experiments` | training and evaluation runs | search/filter, hardware, params, cost |
| `/experiments/:id` | explain a run | learning curves, traces, artifacts, failures |
| `/arena` | multi-model A/B comparison | same samples, synchronized predictions, Pareto |
| `/models` | versions, cards, deployments | model capability and license, promotion gate |
| `/jobs` | active compute jobs | SSE progress, cancel, retry policy |
| `/agents` | guided investigations | plans, tool traces, evidence, approval queue |
| `/settings` | device, privacy, budgets, providers | validation and diagnostics, no raw key echo |

## Frontend implementation

Next.js App Router, React, TypeScript strict; TanStack Query for server cache, Table/Virtual for large lists, `nuqs` or equivalent URL state for shareable filters, accessible primitives (Radix/shadcn) with explicit design tokens and dark-mode compliance. Drawing canvas for geometry isolated behind a component seam with keyboard fallback; thumbnail prefetch and image virtualization to avoid blocking navigation.

## Interaction design rules

- Guided demo uses real recorded evaluation artifacts, clearly labeled, no hidden live model calls.
- Every model prediction shows its source/model revision; raw vs calibrated score clearly differentiated.
- Reviewer can inspect original, derived image, metadata, alternatives and history before accepting.
- A/B Arena has per-class outcomes and "show only disagreements" toggle; plot has textual/table equivalent.
- Job panels show actual state, queued/running/succeeded/failed/cancelled, resource/price preview and error details.
- Agent Workspace shows evidence cards and tool graph; any paid or write operation requires explicit approval UI.
- Mobile layout favors inspection and review, not heavyweight segmentation authoring. Desktop prioritizes analytics and canvas.

## Accessibility and perf

WCAG 2.2 AA target; semantic roles, focus management, keyboard commands, reduced motion, accessible progress messages, sufficient contrast, error summaries, no color-only status. Images have meaningful alt where applicable (user content privacy considered); annotation geometry has synchronized text list and keyboard editing. Use LCP/INP/CLS and virtual list frame budget as measured performance gates; no arbitrary hard-coded loading delays.

## Acceptance examples

Selecting 10k items with filters does not render 10k DOM nodes; filters persist in URL; a rejected annotation remains in audit; a failed API request can be retried without lost unsaved changes; locale-aware number/currency display does not mutate stored metrics; trace viewers preserve source links and never display secrets.
