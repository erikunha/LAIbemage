import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/*/tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/core/src/**/*.ts'],
      exclude: [
        // CLI wiring and top-level orchestration — excluded per project convention
        'packages/core/src/cli/**',
        'packages/core/src/index.ts',
        // Integration adapters — these require live SDKs/network; tested via LLMClient mock
        'packages/core/src/analyzer/client.ts',
        'packages/core/src/analyzer/index.ts',
        // Per-provider client files split from client.ts — same SDK integration boundary
        'packages/core/src/analyzer/providers/**',
        // Suggest pass — requires live LLM client; same integration boundary as client.ts
        'packages/core/src/analyzer/suggest.ts',
        // Reporter port, factory and adapters — thin delegation wrappers over tested reporter fns
        'packages/core/src/reporter/port.ts',
        'packages/core/src/reporter/factory.ts',
        'packages/core/src/reporter/adapters/**',
        // Cloud/filesystem adapters — require live backends; integration test territory
        'packages/core/src/fs/**',
        // XLSX reporter — requires optional exceljs peer dep not installed in CI
        'packages/core/src/reporter/xlsx.ts',
        // I/O-heavy modules — filesystem + Sharp; integration test territory
        'packages/core/src/config/index.ts',
        'packages/core/src/processor/exporter.ts',
        'packages/core/src/processor/index.ts',
        // Terminal UI — cannot unit test (cliProgress/TTY)
        'packages/core/src/utils/progress.ts',
        // Type declarations only — no executable lines
        'packages/core/src/types.ts',
      ],
      thresholds: {
        // Raised after fixture generator + new batch/exif tests landed.
        lines: 75,
        functions: 85,
        branches: 75,
      },
    },
  },
});
