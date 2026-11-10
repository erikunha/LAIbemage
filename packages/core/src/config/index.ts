import * as dotenv from 'dotenv';
import { access, constants, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const OutputFormatSchema = z.enum(['pretty', 'json', 'none', 'csv', 'xlsx', 'sqlite']);
const LogFormatSchema = z.enum(['pretty', 'json']);
export type OutputFormat = z.infer<typeof OutputFormatSchema>;
export type LogFormat = z.infer<typeof LogFormatSchema>;

// ---------------------------------------------------------------------------
// Category config schema — validated at load time so errors surface at startup
// ---------------------------------------------------------------------------

const CategoryDefinitionSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, 'category name must be lowercase snake_case (e.g. "living_room")'),
  description: z.string().min(1),
  examples: z.array(z.string()).optional(),
});

const CategoryConfigSchema = z
  .object({
    description: z.string().optional(),
    categories: z.array(CategoryDefinitionSchema).min(1, 'at least one category is required'),
    pinnedLast: z.array(z.string()).default([]),
    immune: z.array(z.string()).default([]),
    overridable: z.array(z.string()).default([]),
    timezone: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    // Validate IANA timezone
    if (val.timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: val.timezone });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Invalid IANA timezone: "${val.timezone}". Use a value from Intl.supportedValuesOf('timeZone').`,
          path: ['timezone'],
        });
      }
    }
    // Validate that pinnedLast / immune / overridable only reference defined category names
    const defined = new Set(val.categories.map((c) => c.name));
    for (const [field, values] of [
      ['pinnedLast', val.pinnedLast],
      ['immune', val.immune],
      ['overridable', val.overridable],
    ] as const) {
      for (const name of values) {
        if (!defined.has(name) && name !== 'unknown') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `"${name}" in ${field} is not a defined category name.`,
            path: [field],
          });
        }
      }
    }
  });

export interface CategoryDefinition {
  readonly name: string;
  readonly description: string;
  readonly examples?: readonly string[];
}

export interface CategoryConfig {
  readonly description?: string;
  readonly categories: readonly CategoryDefinition[];
  readonly pinnedLast: readonly string[];
  readonly immune: readonly string[];
  readonly overridable: readonly string[];
  readonly timezone?: string;
}

export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'azure'
  | 'ollama'
  | 'hybrid'
  | 'bedrock'
  | 'vertex';

export interface Config {
  readonly inputDir: string;
  readonly outputDir: string;
  readonly categoriesConfigPath?: string;
  readonly categoryConfig: CategoryConfig;
  readonly provider: LLMProvider;
  /** OpenAI API key — used when provider is 'openai'. */
  readonly apiKey: string;
  /** Anthropic API key — used when provider is 'anthropic'. */
  readonly anthropicApiKey: string;
  /** Google AI API key — used when provider is 'google'. */
  readonly googleApiKey: string;
  /** Azure OpenAI endpoint URL — required when provider is 'azure'. Example: https://my-resource.openai.azure.com/ */
  readonly azureEndpoint?: string;
  /** Azure OpenAI API key — required when provider is 'azure'. Overrides AZURE_OPENAI_API_KEY env var. */
  readonly azureApiKey?: string;
  /** Ollama server base URL — required when provider is 'ollama'. Default: http://localhost:11434 */
  readonly ollamaUrl?: string;
  readonly model: string;
  readonly batchSize: number;
  readonly maxRetries: number;
  readonly retryDelayMs: number;
  readonly delayBetweenCallsMs: number;
  readonly dryRun: boolean;
  readonly skipAnalysis: boolean;
  /** When true, skip analysis even if categories.json changed (suppresses hash-mismatch warning). */
  readonly forceSkipAnalysis: boolean;
  /** When true, submit images to provider's async batch API and exit; use --resume to collect. */
  readonly asyncBatch: boolean;
  /** When true, poll an existing async batch job from analysis_job.json until complete, then process. */
  readonly resumeBatch: boolean;
  readonly outputFormat: OutputFormat;
  /** Log format: 'pretty' renders coloured text; 'json' emits one JSON object per line to stdout/stderr. */
  readonly logFormat: LogFormat;
  readonly verbose: boolean;
  readonly quiet: boolean;
  /** Max concurrent API batch calls in-flight at once. Default: 3. */
  readonly concurrency: number;
  /** When true, print cost estimate and exit without making API calls. */
  readonly estimate: boolean;
  /** Temporal cluster window in minutes. Images within this window are grouped. Default: 5. */
  readonly temporalWindowMinutes: number;
  /** Minimum majority ratio (0–1) needed for temporal consensus override. Default: 0.6. */
  readonly consensusThreshold: number;
  /**
   * Hamming distance threshold for perceptual-hash deduplication (0–64).
   * 0 disables deduplication. Default: 8 (~12.5% bit difference).
   */
  readonly dedupeThreshold: number;
  /** When true, print per-step wall-time breakdown in the run summary. */
  readonly timing: boolean;
  /**
   * Output filename template. Must contain {n} or {n:N}.
   * Tokens:
   *   {n} or {n:N}          — sequence number, zero-padded to N digits (default 3)
   *   {category}            — image category slug
   *   {description}         — LLM description as a URL-safe slug
   *   {date}                — DD-MM-YYYY (legacy shorthand)
   *   {date:FORMAT}         — custom date: YYYY YY MM DD M D
   *   {datetime}            — DD-MM-YYYY_HH-MM (legacy shorthand)
   *   {datetime:FORMAT}     — custom datetime: adds HH H mm m ss s
   */
  readonly filenameTemplate: string;
  /** When true, watch inputDir for new images and process them incrementally. */
  readonly watch: boolean;
  /** When true, use polling for file watching (required on NFS/SMB mounts). */
  readonly watchPoll: boolean;
  /** When true, enter interactive review mode between analysis and processing. Requires a TTY. */
  readonly interactive: boolean;
  /** Paths to plugin .mjs files loaded via --plugin (repeatable). */
  readonly plugins: readonly string[];
  /** When true, run cross-image linking pass to identify related image pairs. */
  readonly linkImages: boolean;
  /** Time window in days for grouping images in the linking pass. Default: 7. */
  readonly linkWindowDays: number;
  /** When true, run a self-critique pass that flags suspicious classifications for reanalysis. */
  readonly selfCritique: boolean;
  /** When true, inject override patterns from previous runs into the batch prompt as few-shot examples. */
  readonly learn: boolean;
  /**
   * When true, write active_learning_queue.json after each run listing images with
   * confidence < 0.5 or category === 'unknown' that need human review.
   */
  readonly activeLearnQueue: boolean;
  /** Optional URL to POST the full AnalysisCache JSON to after each successful run. */
  readonly webhookUrl?: string;
  /** Ollama model for the local tier-1 pass in hybrid mode. Default: 'llava'. */
  readonly localModel: string;
  /** Cloud provider to use for tier-2 escalation in hybrid mode. Default: 'openai'. */
  readonly cloudProvider: string;
  /** Confidence threshold below which images are escalated to the cloud tier in hybrid mode. Default: 0.70. */
  readonly localConfidenceThreshold: number;
  /** AWS region for Bedrock (default: us-east-1) */
  readonly bedrockRegion?: string;
  /** AWS access key ID for Bedrock (overrides AWS_ACCESS_KEY_ID env var) */
  readonly bedrockAccessKeyId?: string;
  /** AWS secret access key for Bedrock (overrides AWS_SECRET_ACCESS_KEY env var) */
  readonly bedrockSecretAccessKey?: string;
  /** Google Cloud project ID for Vertex AI (overrides GOOGLE_CLOUD_PROJECT env var) */
  readonly vertexProjectId?: string;
  /** Google Cloud location for Vertex AI (default: us-central1) */
  readonly vertexLocation?: string;
  /**
   * Cloud storage bucket URI for output files, e.g.
   * s3://my-bucket/prefix, gs://my-bucket/prefix, azblob://container/prefix
   * When set, FileRepository adapts to the matching cloud provider.
   */
  readonly outputBucket?: string;
  /**
   * When true, generate text embeddings for each image after analysis and write
   * analysis_embeddings.index.json. Requires a supported embedding provider.
   */
  readonly embed: boolean;
  /**
   * Split images into sessions at gaps larger than this many minutes.
   * Undefined disables session reconstruction. Default when enabled: 60.
   */
  readonly sessionGapMinutes?: number;
  /**
   * Two provider names for multi-model consensus, e.g. ['openai', 'anthropic'].
   * When set, both providers analyse every batch and majority vote decides the category.
   * Disagreements are flagged with `lowConsensus: true` on the ProcessedResult.
   */
  readonly consensusProviders?: readonly string[];
}

// Default categories file — lives in examples/ so config module stays domain-agnostic.
// Resolved relative to the compiled output (dist/config/) → ../../examples/categories.json
const DEFAULT_CATEGORIES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../examples/categories.json',
);

export interface RawCliOptions {
  input?: string;
  inputDir?: string;
  output?: string;
  outputDir?: string;
  config?: string;
  categoriesFile?: string;
  provider?: string;
  apiKey?: string;
  anthropicApiKey?: string;
  googleApiKey?: string;
  azureEndpoint?: string;
  azureApiKey?: string;
  ollamaUrl?: string;
  model?: string;
  batchSize?: number;
  maxRetries?: number;
  dryRun?: boolean;
  skipAnalysis?: boolean;
  forceSkipAnalysis?: boolean;
  asyncBatch?: boolean;
  resumeBatch?: boolean;
  outputFormat?: string;
  logFormat?: string;
  verbose?: boolean;
  quiet?: boolean;
  concurrency?: number;
  estimate?: boolean;
  temporalWindow?: number;
  consensusThreshold?: number;
  dedupeThreshold?: number;
  timing?: boolean;
  filenameTemplate?: string;
  watch?: boolean;
  watchPoll?: boolean;
  interactive?: boolean;
  plugins?: string[];
  linkImages?: boolean;
  linkWindowDays?: number;
  selfCritique?: boolean;
  learn?: boolean;
  activeLearnQueue?: boolean;
  webhookUrl?: string;
  localModel?: string;
  cloudProvider?: string;
  localConfidenceThreshold?: number;
  bedrockRegion?: string;
  bedrockAccessKeyId?: string;
  bedrockSecretAccessKey?: string;
  vertexProjectId?: string;
  vertexLocation?: string;
  outputBucket?: string;
  embed?: boolean;
  sessionGapMinutes?: number;
  consensusProviders?: string[];
}

const DEFAULT_MODEL: Record<string, string> = {
  openai: 'gpt-4o',
  anthropic: 'claude-opus-4-7',
  google: 'gemini-2.0-flash',
  azure: 'gpt-4o',
  ollama: 'llava',
  hybrid: 'llava',
  bedrock: 'anthropic.claude-opus-4-7-20250514-v1:0',
  vertex: 'gemini-2.0-flash',
};

/** Sentinel API key used by operations that do not call any LLM (e.g., reorder). */
export const REORDER_SENTINEL_KEY = 'reorder-no-key-needed';

/**
 * Default output filename template.
 * The template MUST include {n} or {n:N} to guarantee unique filenames.
 * See Config.filenameTemplate for the full token reference.
 */
export const DEFAULT_FILENAME_TEMPLATE = '{n}. Photo of {category} dated {date}';

export async function loadConfig(cliOptions: RawCliOptions): Promise<Config> {
  dotenv.config();

  const provider = (
    ['openai', 'anthropic', 'google', 'azure', 'ollama', 'hybrid', 'bedrock', 'vertex'].includes(
      cliOptions.provider ?? process.env['LLM_PROVIDER'] ?? '',
    )
      ? (cliOptions.provider ?? process.env['LLM_PROVIDER'])
      : 'openai'
  ) as LLMProvider;

  const apiKey = cliOptions.apiKey ?? process.env['OPENAI_API_KEY'] ?? '';
  const anthropicApiKey = cliOptions.anthropicApiKey ?? process.env['ANTHROPIC_API_KEY'] ?? '';
  const googleApiKey = cliOptions.googleApiKey ?? process.env['GOOGLE_API_KEY'] ?? '';
  const azureApiKey = cliOptions.azureApiKey ?? process.env['AZURE_OPENAI_API_KEY'] ?? '';
  const azureEndpoint = cliOptions.azureEndpoint ?? process.env['AZURE_OPENAI_ENDPOINT'] ?? '';
  const ollamaUrl = cliOptions.ollamaUrl ?? process.env['OLLAMA_URL'] ?? 'http://localhost:11434';
  const bedrockRegion = cliOptions.bedrockRegion ?? process.env['AWS_REGION'] ?? 'us-east-1';
  const bedrockAccessKeyId = cliOptions.bedrockAccessKeyId ?? process.env['AWS_ACCESS_KEY_ID'];
  const bedrockSecretAccessKey =
    cliOptions.bedrockSecretAccessKey ?? process.env['AWS_SECRET_ACCESS_KEY'];
  const vertexProjectId = cliOptions.vertexProjectId ?? process.env['GOOGLE_CLOUD_PROJECT'];
  const vertexLocation = cliOptions.vertexLocation ?? 'us-central1';

  // Skip key validation for operations that do not call the LLM
  const skipKeyValidation =
    cliOptions.skipAnalysis === true ||
    cliOptions.forceSkipAnalysis === true ||
    apiKey === REORDER_SENTINEL_KEY;

  if (!skipKeyValidation) {
    if (provider === 'openai' && !apiKey) {
      throw new Error(
        'OpenAI API key is required.\n' +
          '  Set OPENAI_API_KEY, add it to a .env file, or pass --api-key.\n' +
          '  Get your key at: https://platform.openai.com/api-keys',
      );
    }
    if (provider === 'anthropic' && !anthropicApiKey) {
      throw new Error(
        'Anthropic API key is required.\n' +
          '  Set ANTHROPIC_API_KEY, add it to a .env file, or pass --anthropic-api-key.\n' +
          '  Get your key at: https://console.anthropic.com/settings/keys',
      );
    }
    if (provider === 'google' && !googleApiKey) {
      throw new Error(
        'Google AI API key is required.\n' +
          '  Set GOOGLE_API_KEY, add it to a .env file, or pass --google-api-key.\n' +
          '  Get your key at: https://aistudio.google.com/app/apikey',
      );
    }
    if (provider === 'azure' && !azureApiKey) {
      throw new Error(
        'Azure OpenAI API key is required.\n' +
          '  Set AZURE_OPENAI_API_KEY, add it to a .env file, or pass --azure-api-key.\n' +
          '  Get your key at: https://portal.azure.com/',
      );
    }
    if (provider === 'azure' && !azureEndpoint) {
      throw new Error(
        'Azure OpenAI endpoint is required.\n' +
          '  Set AZURE_OPENAI_ENDPOINT, add it to a .env file, or pass --azure-endpoint.\n' +
          '  Example: https://my-resource.openai.azure.com/',
      );
    }
    if (provider === 'azure' && azureEndpoint) {
      try {
        const parsed = new URL(azureEndpoint);
        if (parsed.protocol !== 'https:') {
          throw new Error(`[error] --azure-endpoint must use HTTPS (got: ${azureEndpoint})`);
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('[error]')) throw err;
        throw new Error(`[error] --azure-endpoint is not a valid URL: ${azureEndpoint}`, {
          cause: err,
        });
      }
    }
  }

  const categoriesConfigPath =
    cliOptions.config ?? cliOptions.categoriesFile ?? process.env['CATEGORIES_CONFIG'];
  const resolvedCategoriesPath = categoriesConfigPath
    ? resolve(categoriesConfigPath)
    : DEFAULT_CATEGORIES_PATH;

  // Security checks only apply to user-supplied paths (not the bundled default)
  if (categoriesConfigPath) {
    if (!resolvedCategoriesPath.endsWith('.json')) {
      throw new Error(
        `[error] --categories path must point to a .json file.\n  Resolved: ${resolvedCategoriesPath}`,
      );
    }
    const SENSITIVE_PREFIXES = ['/etc/', '/proc/', '/sys/', '/dev/'];
    if (SENSITIVE_PREFIXES.some((p) => resolvedCategoriesPath.startsWith(p))) {
      throw new Error(
        `[error] --categories path resolves to a restricted system directory.\n  Resolved: ${resolvedCategoriesPath}`,
      );
    }
  }

  const categoriesRaw = await readFile(resolvedCategoriesPath, 'utf-8').catch(() => {
    throw new Error(
      categoriesConfigPath
        ? `[error] Cannot read categories file: ${categoriesConfigPath}`
        : `[error] Default categories file not found: ${DEFAULT_CATEGORIES_PATH}\n  Re-clone or restore examples/categories.json.`,
    );
  });
  let parsedCategories: unknown;
  try {
    parsedCategories = JSON.parse(categoriesRaw);
  } catch {
    throw new Error(
      `[error] categories file is not valid JSON: ${categoriesConfigPath ?? DEFAULT_CATEGORIES_PATH}`,
    );
  }
  const categoriesResult = CategoryConfigSchema.safeParse(parsedCategories);
  if (!categoriesResult.success) {
    const issues = categoriesResult.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `[error] Invalid categories file (${categoriesConfigPath ?? DEFAULT_CATEGORIES_PATH}):\n${issues}`,
    );
  }
  const categoryConfig = categoriesResult.data as CategoryConfig;

  const outputFormat: OutputFormat = OutputFormatSchema.catch('pretty').parse(
    cliOptions.outputFormat,
  );

  const logFormat: LogFormat = LogFormatSchema.catch('pretty').parse(
    cliOptions.logFormat ?? process.env['LOG_FORMAT'],
  );

  const defaultModel = DEFAULT_MODEL[provider] ?? 'gpt-4o';

  return {
    inputDir: cliOptions.inputDir ?? cliOptions.input ?? process.env['INPUT_DIR'] ?? './input',
    outputDir: cliOptions.outputDir ?? cliOptions.output ?? process.env['OUTPUT_DIR'] ?? './output',
    categoriesConfigPath,
    categoryConfig,
    provider,
    apiKey,
    anthropicApiKey,
    googleApiKey,
    azureEndpoint: azureEndpoint || undefined,
    azureApiKey: azureApiKey || undefined,
    ollamaUrl: ollamaUrl || 'http://localhost:11434',
    model: cliOptions.model ?? process.env['MODEL'] ?? process.env['OPENAI_MODEL'] ?? defaultModel,
    batchSize: cliOptions.batchSize ?? parseInt(process.env['BATCH_SIZE'] ?? '20', 10),
    maxRetries: cliOptions.maxRetries ?? parseInt(process.env['MAX_RETRIES'] ?? '3', 10),
    retryDelayMs: 10_000,
    delayBetweenCallsMs: 1_500,
    dryRun: cliOptions.dryRun ?? false,
    skipAnalysis: cliOptions.skipAnalysis ?? false,
    forceSkipAnalysis: cliOptions.forceSkipAnalysis ?? false,
    asyncBatch: cliOptions.asyncBatch ?? false,
    resumeBatch: cliOptions.resumeBatch ?? false,
    outputFormat,
    logFormat,
    verbose: cliOptions.verbose ?? false,
    quiet: cliOptions.quiet ?? false,
    concurrency: cliOptions.concurrency ?? parseInt(process.env['CONCURRENCY'] ?? '3', 10),
    estimate: cliOptions.estimate ?? false,
    temporalWindowMinutes: resolveTemporalWindow(cliOptions.temporalWindow),
    consensusThreshold: resolveConsensusThreshold(cliOptions.consensusThreshold),
    dedupeThreshold: resolveDedupeThreshold(cliOptions.dedupeThreshold),
    timing: cliOptions.timing ?? false,
    filenameTemplate:
      cliOptions.filenameTemplate ?? process.env['FILENAME_TEMPLATE'] ?? DEFAULT_FILENAME_TEMPLATE,
    watch: cliOptions.watch ?? false,
    watchPoll: cliOptions.watchPoll ?? false,
    interactive: cliOptions.interactive ?? false,
    plugins: cliOptions.plugins ?? [],
    linkImages: cliOptions.linkImages ?? false,
    linkWindowDays: cliOptions.linkWindowDays ?? 7,
    selfCritique: cliOptions.selfCritique ?? false,
    learn: cliOptions.learn ?? false,
    activeLearnQueue: cliOptions.activeLearnQueue ?? false,
    localModel: cliOptions.localModel ?? 'llava',
    cloudProvider: cliOptions.cloudProvider ?? 'openai',
    localConfidenceThreshold: cliOptions.localConfidenceThreshold ?? 0.7,
    webhookUrl: cliOptions.webhookUrl,
    bedrockRegion,
    bedrockAccessKeyId,
    bedrockSecretAccessKey,
    vertexProjectId,
    vertexLocation,
    outputBucket: cliOptions.outputBucket ?? process.env['OUTPUT_BUCKET'],
    embed: cliOptions.embed ?? false,
    sessionGapMinutes: cliOptions.sessionGapMinutes,
    consensusProviders: cliOptions.consensusProviders,
  };
}

function resolveTemporalWindow(raw: number | undefined): number {
  const minutes = raw ?? parseInt(process.env['TEMPORAL_WINDOW_MINUTES'] ?? '5', 10);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error(
      `[error] --temporal-window must be a positive number of minutes (got: ${String(raw)})`,
    );
  }
  return minutes;
}

function resolveConsensusThreshold(raw: number | undefined): number {
  const threshold = raw ?? parseFloat(process.env['CONSENSUS_THRESHOLD'] ?? '0.6');
  if (!Number.isFinite(threshold) || threshold <= 0.5 || threshold > 1.0) {
    throw new Error(
      `[error] --consensus-threshold must be a number in the range (0.5, 1.0] (got: ${String(raw)})`,
    );
  }
  return threshold;
}

function resolveDedupeThreshold(raw: number | undefined): number {
  const threshold = raw ?? parseInt(process.env['DEDUPE_THRESHOLD'] ?? '8', 10);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 64) {
    throw new Error(`[error] --dedupe-threshold must be an integer 0–64 (got: ${String(raw)})`);
  }
  return threshold;
}

/** Billing / key help URLs per provider. */
const BILLING_URL: Record<LLMProvider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  google: 'https://aistudio.google.com/app/apikey',
  azure: 'https://portal.azure.com/',
  ollama: 'https://ollama.ai/',
  hybrid: 'https://platform.openai.com/api-keys',
  bedrock: 'https://aws.amazon.com/bedrock/',
  vertex: 'https://cloud.google.com/vertex-ai',
};

/** Providers that use IAM/ADC instead of an explicit API key — no key check required. */
const KEYLESS_PROVIDERS = new Set<LLMProvider>(['ollama', 'hybrid', 'bedrock', 'vertex']);

/**
 * Validate startup preconditions before any I/O or API calls.
 * Throws a plain Error with a one-line actionable message on the first failure.
 * All failures should be caught by the CLI and exit with code 1.
 */
export async function validateStartup(config: Config): Promise<void> {
  // API key check (already done in loadConfig, but kept here for completeness when
  // validateStartup is called separately e.g. from runBatch)
  if (!config.skipAnalysis && !config.forceSkipAnalysis) {
    // bedrock uses IAM credentials; vertex uses ADC/service account — no explicit API key required
    if (!KEYLESS_PROVIDERS.has(config.provider)) {
      const cloudProviderForKey =
        config.provider === 'hybrid' ? config.cloudProvider : config.provider;
      const keyMap: Partial<Record<LLMProvider, string>> = {
        openai: config.apiKey,
        anthropic: config.anthropicApiKey,
        google: config.googleApiKey,
        azure: config.azureApiKey ?? '',
      };
      const key =
        config.provider === 'hybrid'
          ? ({
              openai: config.apiKey,
              anthropic: config.anthropicApiKey,
              google: config.googleApiKey,
            }[cloudProviderForKey] ?? '')
          : (keyMap[config.provider] ?? '');
      if (!key) {
        throw new Error(
          `[error] ${config.provider} API key is missing. Get yours at: ${BILLING_URL[config.provider]}`,
        );
      }
    }
    if (config.provider === 'azure' && !config.azureEndpoint) {
      throw new Error(
        '[error] Azure OpenAI endpoint is missing. Pass --azure-endpoint or set AZURE_OPENAI_ENDPOINT.',
      );
    }
  }

  // Categories config must have at least one category
  if (!config.categoryConfig.categories || config.categoryConfig.categories.length === 0) {
    throw new Error('[error] categories.json must define at least one category.');
  }

  // Filename template must include {n} or {n:N} to guarantee unique output filenames
  if (!/{n(?::\d+)?}/.test(config.filenameTemplate)) {
    throw new Error(
      `[error] --filename-template must include {n} or {n:N} to guarantee unique filenames.\n` +
        `  Got: "${config.filenameTemplate}"`,
    );
  }

  // Input directory must exist and be readable
  try {
    await access(resolve(config.inputDir), constants.R_OK);
  } catch {
    throw new Error(
      `[error] Input directory is not readable: ${config.inputDir}\n  Create it or pass a different --input path.`,
    );
  }

  // Output directory must be writable (or creatable)
  try {
    await access(resolve(config.outputDir), constants.W_OK);
  } catch {
    // Directory may not exist yet — that is fine, fs.ensureDir will create it
    // Only fail if it exists but is not writable
    try {
      await access(resolve(config.outputDir), constants.F_OK);
      // It exists but is not writable
      throw new Error(`[error] Output directory exists but is not writable: ${config.outputDir}`);
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') throw inner;
      // ENOENT means it doesn't exist yet — will be created by fs.ensureDir, that's fine
    }
  }
}
