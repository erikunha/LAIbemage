#!/usr/bin/env node
/**
 * Compatibility bin for the deprecated `ai-image-labeling` command.
 *
 * Prints exactly one deprecation line to stderr (suppress with
 * VISION_LENS_NO_DEPRECATION=1), then delegates to the canonical `vision-lens` entry
 * (`dist/index.js`), which parses `process.argv` itself — argv is forwarded
 * unchanged, so behavior and exit codes are identical to `vision-lens`.
 */
if (process.env.VISION_LENS_NO_DEPRECATION !== '1') {
  process.stderr.write(
    "warning: 'ai-image-labeling' is deprecated; use 'vision-lens' (see README Vision Lens evolution)\n",
  );
}
await import('./index.js');
