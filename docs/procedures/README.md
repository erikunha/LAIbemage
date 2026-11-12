# Procedures

Step-by-step engineering procedures for Vision Lens: how to extend the tool, tune it, operate
it and recover from failures. Each procedure is plain markdown, self-contained and names the
real files it touches. To add one, see [contributing-procedures.md](./contributing-procedures.md).

These procedures are also exposed as thin skill wrappers under `.agents/skills/`, pointers back to
these files.

| Procedure | Use when |
| --------- | -------- |
| [add-provider](./add-provider.md) | A new LLM vision provider is wired in end to end, a plain CLI flag is added, a new analysis pass is written, or docs must be re-checked after a provider change |
| [add-category](./add-category.md) | A category is added to a `categories.json` taxonomy, a new domain taxonomy is designed from scratch, or the analysis cache schema must migrate |
| [tune-prompt](./tune-prompt.md) | The unknown rate is high, two categories confuse each other, a new domain needs prompt guidance, or two runs must be compared with `vision-lens diff` |
| [debug-classification](./debug-classification.md) | Images land in the wrong category, results differ between runs or providers, consensus overrides a correct label, or the untrusted-data path needs a security review |
| [async-batch](./async-batch.md) | Hundreds or thousands of images go to a provider batch API, or a submitted batch job must be inspected, resumed or recovered |
| [recover-partial-run](./recover-partial-run.md) | A run was interrupted (Ctrl-C, OOM kill, network failure, power loss) and must resume without losing or re-paying for images |
| [interpret-benchmark](./interpret-benchmark.md) | A benchmark has run and the report must be read: accuracy against the baseline, precision, recall, unknown rate, cost, latency |
| [search](./search.md) | The classified collection is searched by description or concept, the embedding index is built, or search returns wrong or no results |
| [write-plugin](./write-plugin.md) | An external `.mjs` lifecycle plugin is written: hooks, secrets, I/O isolation, unit tests, dry run |
| [contributing-procedures](./contributing-procedures.md) | A repeatable task needs its own procedure document in this directory |
