import Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { AsyncBatchClient, AsyncBatchRequest, LLMClient } from '../client.js';
import { ANTHROPIC_BATCH_TOOL } from './schemas.js';

/**
 * Message types re-exported from the provider module so tests can build
 * fixtures without importing the Anthropic SDK (the SDK may only be imported
 * inside providers/).
 */
export type AnthropicMessage = Anthropic.Message;
export type AnthropicMessageCreateParams = Anthropic.MessageCreateParamsNonStreaming;
export type AnthropicContentBlockParam = Anthropic.ContentBlockParam;
/** Batch types, re-exported for the same reason as the message types. */
export type AnthropicMessageBatch = Anthropic.Messages.Batches.MessageBatch;
export type AnthropicBatchCreateParams = Anthropic.Messages.Batches.BatchCreateParams;

/** Options handed to the Anthropic SDK client. */
export interface AnthropicClientOptions {
  readonly apiKey: string;
  /** Headers sent with every request (for example the workspace id header). */
  readonly defaultHeaders?: Record<string, string>;
}

/** The slice of the Anthropic messages API used by the sync client. */
export interface AnthropicMessagesApi {
  readonly messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/** The slice of the Anthropic batches API used by the async batch client. */
export interface AnthropicBatchesApi {
  readonly messages: {
    /**
     * Sending a single message. The real SDK client can do this, and the async
     * batch client uses it to probe whether the model accepts a forced tool
     * choice before the batch is created. Clients that cannot send a single
     * message simply skip the probe.
     */
    readonly create?: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
    readonly batches: {
      create(
        body: Anthropic.Messages.Batches.BatchCreateParams,
      ): Promise<Anthropic.Messages.Batches.MessageBatch>;
      retrieve(batchId: string): Promise<Anthropic.Messages.Batches.MessageBatch>;
      results(
        batchId: string,
      ): Promise<AsyncIterable<Anthropic.Messages.Batches.MessageBatchIndividualResponse>>;
    };
  };
}

/**
 * Creates the SDK client. Injectable so tests can supply a fake client instead
 * of mocking the SDK constructor.
 */
export type AnthropicClientFactory = (options: AnthropicClientOptions) => AnthropicMessagesApi;

/** Creates the SDK client used for async batches. Injectable for the same reason. */
export type AnthropicBatchFactory = (options: AnthropicClientOptions) => AnthropicBatchesApi;

const defaultClientFactory: AnthropicClientFactory = (options) => new Anthropic(options);
const defaultBatchFactory: AnthropicBatchFactory = (options) => new Anthropic(options);

/**
 * Build the SDK options. API keys that are not scoped to a workspace need the
 * workspace id sent as a default header.
 */
export function buildAnthropicOptions(config: Config): AnthropicClientOptions {
  return {
    apiKey: config.anthropicApiKey,
    ...(config.anthropicWorkspaceId && {
      defaultHeaders: { 'anthropic-workspace-id': config.anthropicWorkspaceId },
    }),
  };
}

/** Models that reject forced tool use answer 400 with a tool_choice message. */
function isToolChoiceRejection(error: unknown): boolean {
  const err = error as { status?: number; message?: string };
  return err.status === 400 && (err.message?.includes('tool_choice') ?? false);
}

/** Reminder appended when the tool choice is not forced: the model must still call the tool. */
const SUBMIT_ANALYSIS_REMINDER =
  'Call the submit_analysis tool with your complete answer. Do not reply with plain text.';

/**
 * Build the batch request of one batch group.
 *
 * A forced tool choice is used when the model accepts it. When it does not,
 * the tool choice is automatic and the reminder asks the model to call the
 * tool, which is the same fallback the synchronous client uses.
 */
function buildBatchRequest(
  req: AsyncBatchRequest,
  config: Config,
  forceTool: boolean,
): Anthropic.Messages.Batches.BatchCreateParams.Request {
  const content: Anthropic.MessageParam['content'] = [{ type: 'text', text: req.prompt }];
  for (const img of req.images) {
    content.push({ type: 'text', text: img.label });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: img.base64 },
    });
  }
  const systemBlock: Anthropic.TextBlockParam[] | undefined = req.opts.systemPrompt
    ? [{ type: 'text', text: req.opts.systemPrompt, cache_control: { type: 'ephemeral' } }]
    : undefined;

  return {
    custom_id: req.customId,
    params: {
      model: config.model,
      max_tokens: req.opts.maxTokens,
      ...(systemBlock && { system: systemBlock }),
      tools: [ANTHROPIC_BATCH_TOOL],
      tool_choice: forceTool ? { type: 'tool', name: 'submit_analysis' } : { type: 'auto' },
      messages: [
        {
          role: 'user',
          content: forceTool
            ? content
            : [...content, { type: 'text', text: SUBMIT_ANALYSIS_REMINDER }],
        },
      ],
    },
  };
}

export function createAnthropicClient(
  config: Config,
  createClient: AnthropicClientFactory = defaultClientFactory,
): LLMClient {
  const anthropic = createClient(buildAnthropicOptions(config));
  let forcedToolUnsupported = false;

  return {
    async complete(prompt, images, opts) {
      const content: Anthropic.MessageParam['content'] = [{ type: 'text', text: prompt }];

      for (const img of images) {
        content.push({ type: 'text', text: img.label });
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: img.base64,
          },
        });
      }

      const systemBlock: Anthropic.TextBlockParam[] | undefined = opts.systemPrompt
        ? [
            {
              type: 'text',
              text: opts.systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ]
        : undefined;

      const send = (forceTool: boolean, withReminder: boolean): Promise<Anthropic.Message> =>
        anthropic.messages.create({
          model: config.model,
          max_tokens: opts.maxTokens,
          ...(systemBlock && { system: systemBlock }),
          tools: [ANTHROPIC_BATCH_TOOL],
          tool_choice: forceTool ? { type: 'tool', name: 'submit_analysis' } : { type: 'auto' },
          messages: [
            {
              role: 'user',
              content: withReminder
                ? [...content, { type: 'text', text: SUBMIT_ANALYSIS_REMINDER }]
                : content,
            },
          ],
        });

      let response: Anthropic.Message;
      if (forcedToolUnsupported) {
        // The model rejected forced tool use before, so the tool choice is not
        // forced again. The reminder stays out: later passes on this client
        // expect plain JSON, not a tool call.
        response = await send(false, false);
      } else {
        try {
          response = await send(true, false);
        } catch (error) {
          if (!isToolChoiceRejection(error)) throw error;
          logger.verbose(`  ${config.model} rejects forced tool use; falling back to auto.`);
          forcedToolUnsupported = true;
          // Only this fallback request carries the reminder, so the model still
          // calls the tool.
          response = await send(false, true);
        }
      }

      const toolBlock = response.content.find(
        (b): b is Anthropic.Messages.ToolUseBlock =>
          b.type === 'tool_use' && b.name === 'submit_analysis',
      );
      if (!toolBlock) {
        logger.warn(
          '  Anthropic response had no submit_analysis tool call; treating it as an empty result.',
        );
      }
      const rawText = toolBlock ? JSON.stringify(toolBlock.input) : '{}';

      const usage = response.usage as Anthropic.Usage & {
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      if (usage.cache_creation_input_tokens || usage.cache_read_input_tokens) {
        logger.verbose(
          `  Anthropic cache: created=${usage.cache_creation_input_tokens ?? 0} read=${usage.cache_read_input_tokens ?? 0}`,
        );
      }

      return {
        text: rawText,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        tokensUsed: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
      };
    },
  };
}

export function createAnthropicAsyncBatchClient(
  config: Config,
  createClient: AnthropicBatchFactory = defaultBatchFactory,
): AsyncBatchClient {
  const anthropic = createClient(buildAnthropicOptions(config));

  /**
   * Whether the model accepts a forced tool choice.
   *
   * The batches API validates the params of every request asynchronously, so a
   * rejection of the forced tool choice does not fail the batch creation. The
   * check therefore runs as a single message before the batch is created, the
   * same way the synchronous client discovers the rejection.
   */
  const acceptsForcedTool = async (): Promise<boolean> => {
    const create = anthropic.messages.create;
    if (!create) return true;
    try {
      await create({
        model: config.model,
        max_tokens: 1,
        tools: [ANTHROPIC_BATCH_TOOL],
        tool_choice: { type: 'tool', name: 'submit_analysis' },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }],
      });
      return true;
    } catch (error) {
      if (isToolChoiceRejection(error)) return false;
      // Any other failure says nothing about the tool choice, so the forced
      // tool choice is kept and the batch reports the real error.
      logger.verbose(
        `  Forced tool check for ${config.model} failed: ${(error as Error).message}`,
      );
      return true;
    }
  };

  return {
    async submitBatch(requests: readonly AsyncBatchRequest[]) {
      const forceTool = await acceptsForcedTool();
      if (!forceTool) {
        logger.verbose(
          `  ${config.model} rejects forced tool use; submitting the batch with an automatic tool choice.`,
        );
      }

      const batchRequests = requests.map((req) => buildBatchRequest(req, config, forceTool));
      const customIds = requests.map((req) => req.customId);

      const batch = await anthropic.messages.batches.create({ requests: batchRequests });
      logger.verbose(`  Anthropic async batch created: ${batch.id}`);
      return { jobId: batch.id, customIds };
    },

    async checkStatus(jobId: string) {
      const batch = await anthropic.messages.batches.retrieve(jobId);
      if (batch.processing_status === 'ended') return 'complete';
      if (batch.processing_status === 'canceling') return 'failed';
      return 'pending';
    },

    async retrieveResults(jobId: string, customIds: readonly string[]) {
      const resultsMap = new Map<string, string>();

      for await (const item of await anthropic.messages.batches.results(jobId)) {
        if (item.result.type === 'succeeded') {
          const toolBlock = item.result.message.content.find(
            (b): b is Anthropic.Messages.ToolUseBlock =>
              b.type === 'tool_use' && b.name === 'submit_analysis',
          );
          resultsMap.set(item.custom_id, toolBlock ? JSON.stringify(toolBlock.input) : '{}');
        } else if (item.result.type === 'errored') {
          // The provider explains the failure, so it is not lost in the noise.
          logger.warn(
            `  Batch request ${item.custom_id} failed: ${item.result.error.error.message}`,
          );
        }
      }

      return customIds.map((id) => ({
        customId: id,
        text: resultsMap.get(id) ?? '{}',
        status: (resultsMap.has(id) ? 'success' : 'failed') as 'success' | 'failed',
      }));
    },
  };
}
