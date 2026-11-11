import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../../src/config/index.js';
import {
  createAnthropicAsyncBatchClient,
  createAnthropicClient,
  type AnthropicBatchesApi,
  type AnthropicBatchCreateParams,
  type AnthropicClientOptions,
  type AnthropicContentBlockParam,
  type AnthropicMessage,
  type AnthropicMessageBatch,
  type AnthropicMessageCreateParams,
  type AnthropicMessagesApi,
} from '../../src/analyzer/providers/anthropic.js';

/**
 * The provider is exercised through its injected client factory, never by
 * mocking the Anthropic SDK constructor: the fake implements the same
 * `messages.create` surface the SDK exposes.
 */

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      categories: [],
      pinnedLast: [],
      immune: [],
      overridable: [],
      timezone: 'UTC',
    },
    provider: 'anthropic',
    apiKey: '',
    anthropicApiKey: 'sk-ant-test',
    googleApiKey: '',
    model: 'claude-opus-4-7',
    batchSize: 20,
    maxRetries: 2,
    retryDelayMs: 0,
    delayBetweenCallsMs: 0,
    dryRun: false,
    skipAnalysis: false,
    forceSkipAnalysis: false,
    asyncBatch: false,
    resumeBatch: false,
    outputFormat: 'json',
    logFormat: 'pretty',
    verbose: false,
    quiet: false,
    concurrency: 1,
    estimate: false,
    temporalWindowMinutes: 5,
    consensusThreshold: 0.6,
    dedupeThreshold: 0,
    timing: false,
    filenameTemplate: '{n}. Photo of {category} dated {date}',
    watch: false,
    watchPoll: false,
    interactive: false,
    plugins: [],
    linkImages: false,
    linkWindowDays: 7,
    selfCritique: false,
    learn: false,
    activeLearnQueue: false,
    embed: false,
    localModel: 'llava',
    cloudProvider: 'openai',
    localConfidenceThreshold: 0.7,
    ...overrides,
  };
}

const toolUseContent: AnthropicMessage['content'] = [
  {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'submit_analysis',
    input: { images: [] },
    caller: { type: 'direct' },
  },
];

function makeMessage(content: AnthropicMessage['content']): AnthropicMessage {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content,
    stop_reason: 'tool_use',
    stop_sequence: null,
    container: null,
    stop_details: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 1,
      output_tokens: 2,
      server_tool_use: null,
      service_tier: null,
    },
  };
}

type CreateFn = (params: AnthropicMessageCreateParams) => Promise<AnthropicMessage>;

function fakeMessagesApi(create: CreateFn): AnthropicMessagesApi {
  return { messages: { create: vi.fn(create) } };
}

function fakeBatchesApi(): AnthropicBatchesApi {
  return {
    messages: {
      batches: {
        create: vi.fn(),
        retrieve: vi.fn(),
        results: vi.fn(),
      },
    },
  };
}

/** A batch as the SDK returns it after creation. */
function makeBatch(id: string): AnthropicMessageBatch {
  return {
    id,
    archived_at: null,
    cancel_initiated_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ended_at: null,
    expires_at: '2026-01-02T00:00:00Z',
    processing_status: 'in_progress',
    request_counts: {
      processing: 1,
      succeeded: 0,
      errored: 0,
      canceled: 0,
      expired: 0,
    },
    results_url: null,
    type: 'message_batch',
  };
}

/** 400 answered by a model that does not support forced tool use. */
function toolChoiceError(): Error {
  return Object.assign(
    new Error(
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}',
    ),
    { status: 400 },
  );
}

const opts = { maxTokens: 100 };

describe('anthropic workspace header', () => {
  it('sends the anthropic-workspace-id header when a workspace id is configured', () => {
    const captured: AnthropicClientOptions[] = [];

    createAnthropicClient(makeConfig({ anthropicWorkspaceId: 'wrkspc_1' }), (options) => {
      captured.push(options);
      return fakeMessagesApi(async () => makeMessage(toolUseContent));
    });

    expect(captured[0]).toMatchObject({
      defaultHeaders: { 'anthropic-workspace-id': 'wrkspc_1' },
    });
  });

  it('sends the anthropic-workspace-id header on the async batch client', () => {
    const captured: AnthropicClientOptions[] = [];

    createAnthropicAsyncBatchClient(makeConfig({ anthropicWorkspaceId: 'wrkspc_1' }), (options) => {
      captured.push(options);
      return fakeBatchesApi();
    });

    expect(captured[0]).toMatchObject({
      defaultHeaders: { 'anthropic-workspace-id': 'wrkspc_1' },
    });
  });

  it('sets no default headers when no workspace id is configured', () => {
    const captured: AnthropicClientOptions[] = [];

    createAnthropicClient(makeConfig(), (options) => {
      captured.push(options);
      return fakeMessagesApi(async () => makeMessage(toolUseContent));
    });
    createAnthropicAsyncBatchClient(makeConfig(), (options) => {
      captured.push(options);
      return fakeBatchesApi();
    });

    expect(captured[0]).not.toHaveProperty('defaultHeaders');
    expect(captured[1]).not.toHaveProperty('defaultHeaders');
  });
});

describe('anthropic forced tool use', () => {
  it('forces submit_analysis for models that accept it', async () => {
    const create = vi.fn<CreateFn>(async () => makeMessage(toolUseContent));
    const client = createAnthropicClient(makeConfig(), () => ({ messages: { create } }));

    await client.complete('prompt', [], opts);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].tool_choice).toEqual({ type: 'tool', name: 'submit_analysis' });
  });

  it('retries once with tool_choice auto when the model rejects forced tool use', async () => {
    const create = vi.fn<CreateFn>();
    create.mockRejectedValueOnce(toolChoiceError());
    create.mockResolvedValue(makeMessage(toolUseContent));

    const client = createAnthropicClient(makeConfig(), () => ({ messages: { create } }));
    const result = await client.complete('prompt', [], opts);

    expect(create).toHaveBeenCalledTimes(2);
    const retryParams = create.mock.calls[1]![0];
    expect(retryParams.tool_choice).toEqual({ type: 'auto' });

    const blocks = retryParams.messages[0]!.content as AnthropicContentBlockParam[];
    const lastBlock = blocks.at(-1) as AnthropicContentBlockParam & { text: string };
    expect(lastBlock.type).toBe('text');
    expect(lastBlock.text).toContain('submit_analysis');

    expect(result.text).toBe(JSON.stringify({ images: [] }));
  });

  it('remembers the fallback so later calls go straight to auto', async () => {
    const create = vi.fn<CreateFn>();
    create.mockRejectedValueOnce(toolChoiceError());
    create.mockResolvedValue(makeMessage(toolUseContent));

    const client = createAnthropicClient(makeConfig(), () => ({ messages: { create } }));
    await client.complete('prompt', [], opts);
    create.mockClear();

    await client.complete('prompt', [], opts);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0].tool_choice).toEqual({ type: 'auto' });
  });

  it('does not fall back for 400 errors unrelated to tool_choice', async () => {
    const err = Object.assign(new Error('400 invalid image'), { status: 400 });
    const create = vi.fn<CreateFn>();
    create.mockRejectedValue(err);

    const client = createAnthropicClient(makeConfig(), () => ({ messages: { create } }));

    await expect(client.complete('prompt', [], opts)).rejects.toBe(err);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not fall back for non-400 errors that mention tool_choice', async () => {
    const err = Object.assign(new Error('500 tool_choice exploded'), { status: 500 });
    const create = vi.fn<CreateFn>();
    create.mockRejectedValue(err);

    const client = createAnthropicClient(makeConfig(), () => ({ messages: { create } }));

    await expect(client.complete('prompt', [], opts)).rejects.toBe(err);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps the tool reminder on the fallback request only', async () => {
    const create = vi.fn<CreateFn>();
    create.mockRejectedValueOnce(toolChoiceError());
    create.mockResolvedValue(makeMessage(toolUseContent));

    const client = createAnthropicClient(makeConfig(), () => ({ messages: { create } }));
    await client.complete('prompt', [], opts);

    // The fallback request asks the model to call the tool.
    const fallbackBlocks = create.mock.calls[1]![0].messages[0]!.content as AnthropicContentBlockParam[];
    expect(fallbackBlocks.at(-1)).toMatchObject({
      type: 'text',
      text: expect.stringContaining('submit_analysis'),
    });

    create.mockClear();
    await client.complete('prompt', [], opts);

    // A later pass on the same client expects plain JSON, so the reminder
    // must not be repeated.
    const laterBlocks = create.mock.calls[0]![0].messages[0]!.content as AnthropicContentBlockParam[];
    expect(laterBlocks).toHaveLength(1);
    expect(laterBlocks[0]).toMatchObject({ type: 'text', text: 'prompt' });
  });
});

describe('anthropic async batch forced tool use', () => {
  const batchRequest = {
    customId: 'batch-0',
    prompt: 'analyse',
    images: [],
    opts: { maxTokens: 100 },
  };

  function batchesApi(create: CreateFn): {
    api: AnthropicBatchesApi;
    batchesCreate: ReturnType<typeof vi.fn>;
  } {
    const batchesCreate = vi.fn(async () => makeBatch('batch_1'));
    return {
      api: {
        messages: {
          create,
          batches: { create: batchesCreate, retrieve: vi.fn(), results: vi.fn() },
        },
      },
      batchesCreate,
    };
  }

  function submittedRequest(batchesCreate: ReturnType<typeof vi.fn>): AnthropicBatchCreateParams.Request {
    const body = batchesCreate.mock.calls[0]![0] as AnthropicBatchCreateParams;
    return body.requests[0]!;
  }

  it('forces the tool choice when the model accepts it', async () => {
    const create = vi.fn<CreateFn>(async () => makeMessage(toolUseContent));
    const { api, batchesCreate } = batchesApi(create);
    const client = createAnthropicAsyncBatchClient(makeConfig(), () => api);

    await client.submitBatch([batchRequest]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(submittedRequest(batchesCreate).params.tool_choice).toEqual({
      type: 'tool',
      name: 'submit_analysis',
    });
  });

  it('falls back to an automatic tool choice when the model rejects forced tool use', async () => {
    const create = vi.fn<CreateFn>();
    create.mockRejectedValue(toolChoiceError());
    const { api, batchesCreate } = batchesApi(create);
    const client = createAnthropicAsyncBatchClient(makeConfig(), () => api);

    await client.submitBatch([batchRequest]);

    const submitted = submittedRequest(batchesCreate);
    expect(submitted.params.tool_choice).toEqual({ type: 'auto' });
    const blocks = submitted.params.messages[0]!.content as AnthropicContentBlockParam[];
    expect(blocks.at(-1)).toMatchObject({
      type: 'text',
      text: expect.stringContaining('submit_analysis'),
    });
  });

  it('keeps the forced tool choice when the check fails for another reason', async () => {
    const create = vi.fn<CreateFn>();
    create.mockRejectedValue(Object.assign(new Error('500 server error'), { status: 500 }));
    const { api, batchesCreate } = batchesApi(create);
    const client = createAnthropicAsyncBatchClient(makeConfig(), () => api);

    await client.submitBatch([batchRequest]);

    expect(submittedRequest(batchesCreate).params.tool_choice).toEqual({
      type: 'tool',
      name: 'submit_analysis',
    });
  });

  it('keeps the forced tool choice when the client cannot send a single message', async () => {
    const { api, batchesCreate } = batchesApi(vi.fn<CreateFn>());
    const client = createAnthropicAsyncBatchClient(makeConfig(), () => ({
      messages: { batches: api.messages.batches },
    }));

    await client.submitBatch([batchRequest]);

    expect(submittedRequest(batchesCreate).params.tool_choice).toEqual({
      type: 'tool',
      name: 'submit_analysis',
    });
  });
});
