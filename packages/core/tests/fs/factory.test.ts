import { describe, expect, it } from 'vitest';
import { AzureBlobFileRepository } from '../../src/fs/azure-blob-adapter.js';
import { createFileRepository, parseOutputBucketUri } from '../../src/fs/factory.js';
import { GCSFileRepository } from '../../src/fs/gcs-adapter.js';
import { NodeFileRepository } from '../../src/fs/node-adapter.js';
import { S3FileRepository } from '../../src/fs/s3-adapter.js';
import type { Config } from '../../src/config/index.js';

// ---------------------------------------------------------------------------
// Minimal Config factory — all required fields present; no `as Config` cast
// ---------------------------------------------------------------------------
function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    inputDir: './input',
    outputDir: './output',
    categoryConfig: {
      categories: [{ name: 'kitchen', description: 'Kitchen area' }],
      pinnedLast: [],
      immune: [],
      overridable: [],
      timezone: 'UTC',
    },
    provider: 'openai',
    apiKey: 'test-key',
    anthropicApiKey: '',
    googleApiKey: '',
    model: 'gpt-4o',
    batchSize: 5,
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
    filenameTemplate: '{n}. {description} dated {date}.{ext}',
    watch: false,
    watchPoll: false,
    interactive: false,
    plugins: [],
    linkImages: false,
    linkWindowDays: 7,
    selfCritique: false,
    learn: false,
    activeLearnQueue: false,
    localModel: 'llava',
    cloudProvider: 'openai',
    localConfidenceThreshold: 0.7,
    embed: false,
    serveLogRequests: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseOutputBucketUri
// ---------------------------------------------------------------------------
describe('parseOutputBucketUri', () => {
  it('parses an s3 URI with no prefix', () => {
    const result = parseOutputBucketUri('s3://my-bucket');
    expect(result).toEqual({ scheme: 's3', bucket: 'my-bucket', prefix: '' });
  });

  it('parses an s3 URI with a prefix', () => {
    const result = parseOutputBucketUri('s3://my-bucket/some/prefix');
    expect(result).toEqual({ scheme: 's3', bucket: 'my-bucket', prefix: 'some/prefix' });
  });

  it('parses a gs URI with no prefix', () => {
    const result = parseOutputBucketUri('gs://my-bucket');
    expect(result).toEqual({ scheme: 'gs', bucket: 'my-bucket', prefix: '' });
  });

  it('parses a gs URI with a prefix', () => {
    const result = parseOutputBucketUri('gs://my-bucket/output/dir');
    expect(result).toEqual({ scheme: 'gs', bucket: 'my-bucket', prefix: 'output/dir' });
  });

  it('parses an azblob URI with no prefix', () => {
    const result = parseOutputBucketUri('azblob://mycontainer');
    expect(result).toEqual({ scheme: 'azblob', bucket: 'mycontainer', prefix: '' });
  });

  it('parses an azblob URI with a prefix', () => {
    const result = parseOutputBucketUri('azblob://mycontainer/results/2024');
    expect(result).toEqual({ scheme: 'azblob', bucket: 'mycontainer', prefix: 'results/2024' });
  });

  it('throws on an invalid URI', () => {
    expect(() => parseOutputBucketUri('http://not-valid')).toThrow(/Invalid --output-bucket URI/);
  });

  it('throws when the scheme is unsupported', () => {
    expect(() => parseOutputBucketUri('ftp://bucket/path')).toThrow(/Invalid --output-bucket URI/);
  });
});

// ---------------------------------------------------------------------------
// createFileRepository
// ---------------------------------------------------------------------------
describe('createFileRepository', () => {
  it('returns NodeFileRepository when outputBucket is not set', () => {
    const repo = createFileRepository(makeConfig());
    expect(repo).toBeInstanceOf(NodeFileRepository);
  });

  it('returns NodeFileRepository when outputBucket is undefined', () => {
    const repo = createFileRepository(makeConfig({ outputBucket: undefined }));
    expect(repo).toBeInstanceOf(NodeFileRepository);
  });

  it('returns S3FileRepository for s3:// URIs', () => {
    const repo = createFileRepository(makeConfig({ outputBucket: 's3://my-bucket/prefix' }));
    expect(repo).toBeInstanceOf(S3FileRepository);
  });

  it('returns S3FileRepository for s3:// URI with no prefix', () => {
    const repo = createFileRepository(makeConfig({ outputBucket: 's3://my-bucket' }));
    expect(repo).toBeInstanceOf(S3FileRepository);
  });

  it('returns GCSFileRepository for gs:// URIs', () => {
    const repo = createFileRepository(makeConfig({ outputBucket: 'gs://my-bucket/prefix' }));
    expect(repo).toBeInstanceOf(GCSFileRepository);
  });

  it('returns AzureBlobFileRepository for azblob:// URIs', () => {
    const repo = createFileRepository(makeConfig({ outputBucket: 'azblob://mycontainer/prefix' }));
    expect(repo).toBeInstanceOf(AzureBlobFileRepository);
  });

  it('passes Bedrock credentials to S3FileRepository', () => {
    // Just verify it constructs without error when credentials are provided
    const repo = createFileRepository(
      makeConfig({
        outputBucket: 's3://secure-bucket/out',
        bedrockRegion: 'eu-west-1',
        bedrockAccessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        bedrockSecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      }),
    );
    expect(repo).toBeInstanceOf(S3FileRepository);
  });

  it('passes vertexProjectId to GCSFileRepository', () => {
    const repo = createFileRepository(
      makeConfig({ outputBucket: 'gs://my-bucket', vertexProjectId: 'my-gcp-project' }),
    );
    expect(repo).toBeInstanceOf(GCSFileRepository);
  });

  it('throws on an invalid URI scheme', () => {
    expect(() => createFileRepository(makeConfig({ outputBucket: 'ftp://bucket/path' }))).toThrow(
      /Invalid --output-bucket URI/,
    );
  });
});
