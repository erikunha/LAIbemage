/**
 * Programmatic entry for the Vision Lens CLI — restores the pre-migration
 * `@vision-lens/sdk` `./cli` export (which pointed at `dist/cli/index.js`).
 *
 * CAUTION: `@vision-lens/cli`'s entry parses `process.argv` at import time
 * and runs the matched command. Importing this module from library code
 * executes the CLI — the same semantics the old `./cli` export had. Use the
 * `.` entry (`@vision-lens/sdk`) for the side-effect-free library API.
 */
export { program } from '@vision-lens/cli';
