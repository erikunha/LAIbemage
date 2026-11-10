/** @type {import('@stryker-mutator/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  testRunnerNodeArgs: ['--experimental-vm-modules'],
  // Scope mutations to the two pure logic modules with no external I/O
  mutate: ['packages/core/src/classifier/**/*.ts', 'packages/core/src/analyzer/temporal.ts'],
  // Use glob patterns so Stryker can find the relevant test files fast
  vitest: {
    configFile: 'vitest.config.ts',
  },
  thresholds: {
    high: 80,
    low: 70,
    break: 70, // fail the run if score drops below 70%
  },
  reporters: ['progress', 'clear-text', 'html'],
  htmlReporter: {
    fileName: 'reports/mutation/index.html',
  },
  timeoutMS: 15000,
  timeoutFactor: 2,
  // Use the static instrumenter — compatible with NodeNext ESM
  checkers: [],
};
