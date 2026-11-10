/**
 * Programmatic entry for the Master Vision CLI — restores the pre-migration
 * `@master-vision/sdk` `./cli` export (which pointed at `dist/cli/index.js`).
 *
 * CAUTION: `@master-vision/cli`'s entry parses `process.argv` at import time
 * and runs the matched command. Importing this module from library code
 * executes the CLI — the same semantics the old `./cli` export had. Use the
 * `.` entry (`@master-vision/sdk`) for the side-effect-free library API.
 */
export { program } from '@master-vision/cli';
