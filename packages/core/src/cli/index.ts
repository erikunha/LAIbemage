#!/usr/bin/env node
import { Command } from 'commander';
import { loadConfig, REORDER_SENTINEL_KEY } from '../config/index.js';
import {
  runBatch,
  runDiff,
  runReorder,
  runReport,
  runSearch,
  runSingle,
  runSuggestCategories,
  runWatch,
} from '../index.js';
import { configureLogger, logger } from '../utils/logger.js';
import { printHelp } from './help.js';

const program = new Command();

program
  .name('ai-image-labeling')
  .description('AI-powered image classification and organization')
  .version('0.0.1')
  .option('-i, --input <dir>', 'Input directory with source images', './input')
  .option('-o, --output <dir>', 'Output directory for processed files', './output')
  .option(
    '--provider <name>',
    'LLM provider: openai | anthropic | google | bedrock | vertex',
    'openai',
  )
  .option('--api-key <key>', 'OpenAI API key (overrides OPENAI_API_KEY env var)')
  .option('--anthropic-api-key <key>', 'Anthropic API key (overrides ANTHROPIC_API_KEY env var)')
  .option('--google-api-key <key>', 'Google AI API key (overrides GOOGLE_API_KEY env var)')
  .option('--model <model>', 'Model name (defaults: gpt-4o / claude-opus-4-7 / gemini-2.0-flash)')
  .option('--bedrock-region <region>', 'AWS region for Bedrock provider (default: us-east-1)')
  .option(
    '--bedrock-access-key-id <key>',
    'AWS access key ID for Bedrock (overrides AWS_ACCESS_KEY_ID)',
  )
  .option(
    '--bedrock-secret-access-key <key>',
    'AWS secret access key for Bedrock (overrides AWS_SECRET_ACCESS_KEY)',
  )
  .option(
    '--vertex-project <id>',
    'Google Cloud project ID for Vertex AI (overrides GOOGLE_CLOUD_PROJECT)',
  )
  .option(
    '--vertex-location <location>',
    'Google Cloud location for Vertex AI (default: us-central1)',
  )
  .option('--batch-size <n>', 'Images per API call', '20')
  .option('--max-retries <n>', 'Max retries on API errors', '3')
  .option('--concurrency <n>', 'Concurrent API batch calls in-flight', '3')
  .option('--estimate', 'Print cost estimate for all providers and exit', false)
  .option('--temporal-window <minutes>', 'Temporal cluster window in minutes', '5')
  .option('--consensus-threshold <n>', 'Majority ratio for temporal override (0.5–1.0)', '0.6')
  .option('--dedupe-threshold <n>', 'Hamming distance for burst dedup (0–64, 0=off)', '8')
  .option('--dry-run', 'Analyze without writing output files', false)
  .option('--skip-analysis', 'Skip analysis, use cached analysis_results.json', false)
  .option(
    '--force-skip-analysis',
    'Skip analysis using cached results even if categories.json changed',
    false,
  )
  .option(
    '--async',
    'Submit images to provider async batch API and exit (use --resume to collect)',
    false,
  )
  .option('--resume', 'Poll existing async batch job from analysis_job.json until complete', false)
  .option('--categories <file>', 'Path to custom categories.json')
  .option(
    '--output-format <fmt>',
    'Output format: pretty | json | none | csv | xlsx | sqlite',
    'pretty',
  )
  .option('--log-format <fmt>', 'Log format: pretty | json', 'pretty')
  .option('--timing', 'Print per-step wall-time breakdown in run summary', false)
  .option(
    '--filename-template <pattern>',
    'Output filename template — see --help for token reference',
  )
  .option('-v, --verbose', 'Show detailed debug logs', false)
  .option('-q, --quiet', 'Suppress all non-error output', false)
  .option('--watch', 'Watch input directory and process new images automatically', false)
  .option('--watch-poll', 'Use polling for watch mode (required on NFS/SMB mounts)', false)
  .option('--link', 'Run cross-image linking pass to identify related image pairs', false)
  .option(
    '--link-window <days>',
    'Time window in days for grouping images in the linking pass',
    '7',
  )
  .option(
    '--self-critique',
    'Run a self-critique pass that flags suspicious classifications for reanalysis',
    false,
  )
  .option(
    '--learn',
    'Inject override patterns from previous runs into the batch prompt as few-shot examples',
    false,
  )
  .option('--local-model <model>', 'Ollama model for tier-1 local pass in hybrid mode', 'llava')
  .option(
    '--cloud-provider <name>',
    'Cloud provider for tier-2 escalation in hybrid mode: openai | anthropic | google',
    'openai',
  )
  .option(
    '--local-confidence-threshold <n>',
    'Confidence threshold for hybrid escalation (0–1, default 0.70)',
    '0.70',
  )
  .option(
    '--interactive',
    'Review and override LLM classifications before processing (requires TTY)',
    false,
  )
  .option(
    '--active-learn',
    'Write active_learning_queue.json listing images with confidence < 0.5 or unknown category',
    false,
  )
  .option(
    '--plugin <path>',
    'Path to a plugin .mjs file (repeatable)',
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option('--webhook <url>', 'POST analysis_results.json to this URL after each run completes')
  .option(
    '--output-bucket <uri>',
    'Cloud storage bucket URI: s3://bucket/prefix | gs://bucket/prefix | azblob://container/prefix',
  )
  .option(
    '--embed',
    'Generate text embeddings for each image after analysis and write analysis_embeddings.index.json',
    false,
  )
  .option(
    '--session-gap <minutes>',
    'Split images into sessions at gaps larger than this many minutes (e.g. 60)',
  )
  .option(
    '--consensus-providers <p1,p2>',
    'Two comma-separated providers for multi-model consensus, e.g. "openai,anthropic"',
  )
  .addHelpCommand(false)
  .helpOption(false)
  .action(async (opts: Record<string, string | boolean>) => {
    if (opts['help']) {
      printHelp();
      process.exit(0);
    }

    configureLogger({ verbose: Boolean(opts['verbose']), quiet: Boolean(opts['quiet']) });

    try {
      const config = await loadConfig({
        inputDir: opts['input'] as string,
        outputDir: opts['output'] as string,
        provider: opts['provider'] as string | undefined,
        apiKey: opts['apiKey'] as string | undefined,
        anthropicApiKey: opts['anthropicApiKey'] as string | undefined,
        googleApiKey: opts['googleApiKey'] as string | undefined,
        azureEndpoint: opts['azureEndpoint'] as string | undefined,
        azureApiKey: opts['azureApiKey'] as string | undefined,
        ollamaUrl: opts['ollamaUrl'] as string | undefined,
        model: opts['model'] as string | undefined,
        batchSize: parseInt(opts['batchSize'] as string, 10),
        maxRetries: parseInt(opts['maxRetries'] as string, 10),
        concurrency: parseInt(opts['concurrency'] as string, 10),
        estimate: Boolean(opts['estimate']),
        temporalWindow: parseFloat(opts['temporalWindow'] as string),
        consensusThreshold: parseFloat(opts['consensusThreshold'] as string),
        dedupeThreshold: parseInt(opts['dedupeThreshold'] as string, 10),
        dryRun: Boolean(opts['dryRun']),
        skipAnalysis: Boolean(opts['skipAnalysis']),
        forceSkipAnalysis: Boolean(opts['forceSkipAnalysis']),
        asyncBatch: Boolean(opts['async']),
        resumeBatch: Boolean(opts['resume']),
        categoriesFile: opts['categories'] as string | undefined,
        outputFormat: opts['outputFormat'] as string,
        logFormat: opts['logFormat'] as string,
        timing: Boolean(opts['timing']),
        filenameTemplate: opts['filenameTemplate'] as string | undefined,
        watch: Boolean(opts['watch']),
        watchPoll: Boolean(opts['watchPoll']),
        interactive: Boolean(opts['interactive']),
        plugins: (opts['plugin'] as unknown as string[] | undefined) ?? [],
        linkImages: Boolean(opts['link']),
        linkWindowDays: parseInt(opts['linkWindow'] as string, 10),
        selfCritique: Boolean(opts['selfCritique']),
        learn: Boolean(opts['learn']),
        activeLearnQueue: Boolean(opts['activeLearn']),
        localModel: opts['localModel'] as string | undefined,
        cloudProvider: opts['cloudProvider'] as string | undefined,
        localConfidenceThreshold: parseFloat(opts['localConfidenceThreshold'] as string),
        webhookUrl: opts['webhook'] as string | undefined,
        bedrockRegion: opts['bedrockRegion'] as string | undefined,
        bedrockAccessKeyId: opts['bedrockAccessKeyId'] as string | undefined,
        bedrockSecretAccessKey: opts['bedrockSecretAccessKey'] as string | undefined,
        vertexProjectId: opts['vertexProject'] as string | undefined,
        vertexLocation: opts['vertexLocation'] as string | undefined,
        outputBucket: opts['outputBucket'] as string | undefined,
        embed: Boolean(opts['embed']),
        sessionGapMinutes: opts['sessionGap']
          ? parseFloat(opts['sessionGap'] as string)
          : undefined,
        consensusProviders: opts['consensusProviders']
          ? (opts['consensusProviders'] as string)
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined,
        verbose: Boolean(opts['verbose']),
        quiet: Boolean(opts['quiet']),
      });
      if (config.watch) {
        await runWatch(config);
      } else {
        await runBatch(config);
      }
      // process.exitCode may be 2 (partial failures) — do not override it here
    } catch (error) {
      logger.error(String((error as Error).message));
      process.exit(1); // 1 = validation / configuration error
    }
  });

// Reorder subcommand
program
  .command('reorder')
  .description('Re-number output files from cached analysis_results.json')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('-q, --quiet', 'Suppress non-error output', false)
  .action(async (opts: Record<string, string | boolean>, cmd) => {
    const parent = (cmd.parent?.opts() as Record<string, string | boolean>) ?? {};
    configureLogger({ quiet: Boolean(opts['quiet'] ?? parent['quiet']) });
    try {
      const config = await loadConfig({
        outputDir: opts['output'] as string,
        apiKey: REORDER_SENTINEL_KEY,
        dryRun: false,
        skipAnalysis: true,
        outputFormat: 'json',
        logFormat: 'pretty',
        verbose: false,
        quiet: Boolean(opts['quiet']),
        batchSize: 20,
        maxRetries: 3,
      });
      await runReorder(config);
    } catch (error) {
      logger.error(String((error as Error).message));
      process.exit(1); // 1 = validation / configuration error
    }
  });

// Single subcommand
program
  .command('single <number> <file>')
  .description('Process a single image with a specific sequence number')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option(
    '--provider <name>',
    'LLM provider: openai | anthropic | google | azure | ollama',
    'openai',
  )
  .option('--api-key <key>', 'OpenAI API key (overrides OPENAI_API_KEY env var)')
  .option('--anthropic-api-key <key>', 'Anthropic API key (overrides ANTHROPIC_API_KEY env var)')
  .option('--google-api-key <key>', 'Google AI API key (overrides GOOGLE_API_KEY env var)')
  .option('--azure-endpoint <url>', 'Azure OpenAI endpoint URL (requires --provider azure)')
  .option('--azure-api-key <key>', 'Azure OpenAI API key (overrides AZURE_OPENAI_API_KEY env var)')
  .option('--ollama-url <url>', 'Ollama server URL (requires --provider ollama)')
  .option('--model <model>', 'Model name (defaults: gpt-4o / claude-opus-4-7 / gemini-2.0-flash)')
  .option('--categories <file>', 'Path to categories.json')
  .option(
    '--filename-template <pattern>',
    'Output filename template — see --help for token reference',
  )
  .option('-v, --verbose', 'Verbose output', false)
  .option('-q, --quiet', 'Quiet output', false)
  .action(async (num: string, file: string, opts: Record<string, string | boolean>) => {
    configureLogger({ verbose: Boolean(opts['verbose']), quiet: Boolean(opts['quiet']) });
    try {
      const config = await loadConfig({
        outputDir: opts['output'] as string,
        provider: opts['provider'] as string | undefined,
        apiKey: opts['apiKey'] as string | undefined,
        anthropicApiKey: opts['anthropicApiKey'] as string | undefined,
        googleApiKey: opts['googleApiKey'] as string | undefined,
        azureEndpoint: opts['azureEndpoint'] as string | undefined,
        azureApiKey: opts['azureApiKey'] as string | undefined,
        ollamaUrl: opts['ollamaUrl'] as string | undefined,
        model: opts['model'] as string | undefined,
        batchSize: 1,
        maxRetries: 3,
        dryRun: false,
        skipAnalysis: false,
        categoriesFile: opts['categories'] as string | undefined,
        outputFormat: 'json',
        logFormat: 'pretty',
        verbose: Boolean(opts['verbose']),
        quiet: Boolean(opts['quiet']),
        filenameTemplate: opts['filenameTemplate'] as string | undefined,
      });
      await runSingle(config, parseInt(num, 10), file);
    } catch (error) {
      logger.error(String((error as Error).message));
      process.exit(1); // 1 = validation / configuration error
    }
  });

// Report subcommand
program
  .command('report')
  .description('Generate a self-contained HTML report from analysis_results.json')
  .option('-o, --output <dir>', 'Output directory containing analysis_results.json', './output')
  .option('--out <file>', 'Path for the generated report file', './report.html')
  .option('-q, --quiet', 'Suppress non-error output', false)
  .action(async (opts: Record<string, string | boolean>) => {
    configureLogger({ quiet: Boolean(opts['quiet']) });
    try {
      await runReport(opts['output'] as string, opts['out'] as string);
    } catch (error) {
      logger.error(String((error as Error).message));
      process.exit(1);
    }
  });

// Suggest-categories subcommand
program
  .command('suggest-categories')
  .description('Sample images and ask the LLM to suggest a categories.json taxonomy')
  .option('-i, --input <dir>', 'Input directory with source images', './input')
  .option(
    '--out <file>',
    'Output path for the suggested categories.json',
    './categories-suggested.json',
  )
  .option('--sample <n>', 'Number of images to sample', '20')
  .option(
    '--provider <name>',
    'LLM provider: openai | anthropic | google | azure | ollama',
    'openai',
  )
  .option('--api-key <key>', 'OpenAI API key (overrides OPENAI_API_KEY env var)')
  .option('--anthropic-api-key <key>', 'Anthropic API key (overrides ANTHROPIC_API_KEY env var)')
  .option('--google-api-key <key>', 'Google AI API key (overrides GOOGLE_API_KEY env var)')
  .option('--azure-endpoint <url>', 'Azure OpenAI endpoint URL')
  .option('--azure-api-key <key>', 'Azure OpenAI API key')
  .option('--ollama-url <url>', 'Ollama server URL')
  .option('--model <model>', 'Model name (defaults per provider)')
  .option('-v, --verbose', 'Verbose output', false)
  .option('-q, --quiet', 'Quiet output', false)
  .action(async (opts: Record<string, string | boolean>) => {
    configureLogger({ verbose: Boolean(opts['verbose']), quiet: Boolean(opts['quiet']) });
    try {
      const config = await loadConfig({
        inputDir: opts['input'] as string,
        outputDir: opts['out'] as string | undefined,
        provider: opts['provider'] as string | undefined,
        apiKey: opts['apiKey'] as string | undefined,
        anthropicApiKey: opts['anthropicApiKey'] as string | undefined,
        googleApiKey: opts['googleApiKey'] as string | undefined,
        azureEndpoint: opts['azureEndpoint'] as string | undefined,
        azureApiKey: opts['azureApiKey'] as string | undefined,
        ollamaUrl: opts['ollamaUrl'] as string | undefined,
        model: opts['model'] as string | undefined,
        batchSize: 20,
        maxRetries: 3,
        dryRun: false,
        skipAnalysis: true, // no real analysis run
        outputFormat: 'none',
        logFormat: 'pretty',
        verbose: Boolean(opts['verbose']),
        quiet: Boolean(opts['quiet']),
      });
      const outPath = opts['out'] as string;
      const sampleSize = Math.max(1, parseInt(opts['sample'] as string, 10) || 20);
      await runSuggestCategories(config, outPath, sampleSize);
    } catch (error) {
      logger.error(String((error as Error).message));
      process.exit(1);
    }
  });

// Search subcommand (H9.3 / H9.4)
program
  .command('search')
  .description('Search classified images by semantic query or keyword')
  .option('-o, --output <dir>', 'Output directory containing analysis_results.json', './output')
  .option('--query <text>', 'Semantic search query (requires --embed to have been run)')
  .option('--keyword <text>', 'Keyword search across shortDescription, elements, extractedText')
  .option('--top <n>', 'Maximum number of results to return', '10')
  .option('--min-score <n>', 'Minimum similarity score for semantic search (0–1)', '0.4')
  .option('--output-format <fmt>', 'Output format: pretty | json', 'pretty')
  .option('--provider <name>', 'LLM provider (required for --query semantic search)', 'openai')
  .option('--api-key <key>', 'OpenAI API key (overrides OPENAI_API_KEY)')
  .option('--anthropic-api-key <key>', 'Anthropic API key (overrides ANTHROPIC_API_KEY)')
  .option('--google-api-key <key>', 'Google AI API key (overrides GOOGLE_API_KEY)')
  .option('-v, --verbose', 'Verbose output', false)
  .option('-q, --quiet', 'Quiet output', false)
  .action(async (opts: Record<string, string | boolean>) => {
    configureLogger({ verbose: Boolean(opts['verbose']), quiet: Boolean(opts['quiet']) });
    try {
      const config = await loadConfig({
        inputDir: './input',
        outputDir: opts['output'] as string,
        provider: opts['provider'] as string | undefined,
        apiKey: opts['apiKey'] as string | undefined,
        anthropicApiKey: opts['anthropicApiKey'] as string | undefined,
        googleApiKey: opts['googleApiKey'] as string | undefined,
        batchSize: 1,
        maxRetries: 1,
        dryRun: false,
        skipAnalysis: true,
        outputFormat: 'none',
        logFormat: 'pretty',
        verbose: Boolean(opts['verbose']),
        quiet: Boolean(opts['quiet']),
        embed: false,
      });
      const outputFmt = opts['outputFormat'] as string;
      await runSearch(opts['output'] as string, {
        query: opts['query'] as string | undefined,
        keyword: opts['keyword'] as string | undefined,
        top: Math.max(1, parseInt(opts['top'] as string, 10) || 10),
        minScore: parseFloat(opts['minScore'] as string) || 0.4,
        outputFormat: outputFmt === 'json' ? 'json' : 'pretty',
        config,
      });
    } catch (error) {
      logger.error(String((error as Error).message));
      process.exit(1);
    }
  });

// Diff subcommand
program
  .command('diff <before> <after>')
  .description('Compare two analysis_results.json files and show what changed')
  .option('--output-format <fmt>', 'Output format: pretty | json', 'pretty')
  .option('-q, --quiet', 'Suppress non-error output', false)
  .action(async (before: string, after: string, opts: Record<string, string | boolean>) => {
    configureLogger({ quiet: Boolean(opts['quiet']) });
    try {
      const outputFmt = opts['outputFormat'] as string;
      await runDiff(before, after, outputFmt === 'json' ? 'json' : 'pretty');
    } catch (error) {
      logger.error(String((error as Error).message));
      process.exit(1);
    }
  });

program.parseAsync(process.argv);
