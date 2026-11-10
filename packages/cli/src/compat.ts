#!/usr/bin/env node
/**
 * Compatibility bin for the deprecated `ai-image-labeling` command.
 *
 * Prints exactly one deprecation line to stderr (suppress with
 * LAIB_NO_DEPRECATION=1), then delegates to the canonical `laib` entry
 * (`dist/index.js`), which parses `process.argv` itself — argv is forwarded
 * unchanged, so behavior and exit codes are identical to `laib`.
 */
if (process.env.LAIB_NO_DEPRECATION !== '1') {
  process.stderr.write(
    "warning: 'ai-image-labeling' is deprecated; use 'laib' (see README Master evolution)\n",
  );
}
await import('./index.js');
