import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

/**
 * LLM provider SDKs are only allowed inside `packages/core/src/analyzer/providers/**`
 * (see the module boundary table in AGENTS.md). Enforced by `no-restricted-imports`
 * below; `scripts/check-boundaries.mjs` (`pnpm run check:boundaries`) proves the
 * rule fires with a violating fixture and passes a clean one.
 */
const LLM_SDK_MESSAGE =
  'LLM provider SDKs may only be imported inside packages/core/src/analyzer/providers/** — see the module boundary table in AGENTS.md.';

const LLM_SDKS = [
  'openai',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google-cloud/vertexai',
  '@aws-sdk/client-bedrock-runtime',
];

const llmSdkRestriction = {
  paths: LLM_SDKS.map((name) => ({ name, message: LLM_SDK_MESSAGE })),
  patterns: LLM_SDKS.map((name) => ({ group: [`${name}/*`], message: LLM_SDK_MESSAGE })),
};

export default [
  js.configs.recommended,
  {
    files: [
      'packages/*/src/**/*.ts',
      'packages/*/tests/**/*.ts',
      'apps/*/src/**/*.ts',
      'apps/*/tests/**/*.ts',
    ],
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2022,
      },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
      // TypeScript already catches undefined variables; no-undef produces false positives for TS types
      'no-undef': 'off',
      // Boundary rule 1: no LLM SDK anywhere in workspace TS code …
      'no-restricted-imports': ['error', llmSdkRestriction],
    },
  },
  // … except in the provider adapters, where each file owns exactly one SDK
  {
    files: ['packages/core/src/analyzer/providers/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  // Documented carve-out (AGENTS.md analyzer row): embeddings.ts pre-dates the
  // providers/ split and uses the OpenAI + Google text-embedding SDKs directly;
  // routing it through providers/ is a queued task. Anthropic, Vertex and
  // Bedrock stay forbidden here.
  {
    files: ['packages/core/src/analyzer/embeddings.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            '@anthropic-ai/sdk',
            '@google-cloud/vertexai',
            '@aws-sdk/client-bedrock-runtime',
          ].map((name) => ({ name, message: LLM_SDK_MESSAGE })),
          patterns: [
            '@anthropic-ai/sdk/*',
            '@google-cloud/vertexai/*',
            '@aws-sdk/client-bedrock-runtime/*',
          ].map((group) => ({ group: [group], message: LLM_SDK_MESSAGE })),
        },
      ],
    },
  },
];
