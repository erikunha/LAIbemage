import type { Config } from '../config/index.js';
import { AzureBlobFileRepository } from './azure-blob-adapter.js';
import { GCSFileRepository } from './gcs-adapter.js';
import { NodeFileRepository } from './node-adapter.js';
import type { FileRepository } from './port.js';
import { S3FileRepository } from './s3-adapter.js';

/**
 * Parse a cloud storage URI into its scheme, bucket/container, and optional prefix.
 *
 * Supported formats:
 *   s3://bucket-name/optional/prefix
 *   gs://bucket-name/optional/prefix
 *   azblob://container-name/optional/prefix
 */
export function parseOutputBucketUri(uri: string): {
  scheme: string;
  bucket: string;
  prefix: string;
} {
  const match = /^(s3|gs|azblob):\/\/([^/]+)\/?(.*)$/.exec(uri);
  if (!match) {
    throw new Error(
      `Invalid --output-bucket URI: "${uri}". Expected s3://<bucket>[/prefix], gs://<bucket>[/prefix], or azblob://<container>[/prefix].`,
    );
  }
  return {
    scheme: match[1]!,
    bucket: match[2]!,
    prefix: match[3] ?? '',
  };
}

/**
 * Return a FileRepository appropriate for the configured output destination.
 *
 * - When config.outputBucket is not set → local NodeFileRepository.
 * - When it starts with "s3://"      → S3FileRepository (re-uses Bedrock credentials if present).
 * - When it starts with "gs://"      → GCSFileRepository (re-uses Vertex project ID if present).
 * - When it starts with "azblob://"  → AzureBlobFileRepository (reads AZURE_STORAGE_CONNECTION_STRING env var).
 */
export function createFileRepository(config: Config): FileRepository {
  if (!config.outputBucket) {
    return new NodeFileRepository();
  }

  const { scheme, bucket, prefix } = parseOutputBucketUri(config.outputBucket);

  switch (scheme) {
    case 's3': {
      const credentials =
        config.bedrockAccessKeyId && config.bedrockSecretAccessKey
          ? {
              accessKeyId: config.bedrockAccessKeyId,
              secretAccessKey: config.bedrockSecretAccessKey,
            }
          : undefined;
      return new S3FileRepository(bucket, prefix, config.bedrockRegion ?? 'us-east-1', credentials);
    }

    case 'gs':
      return new GCSFileRepository(bucket, prefix, config.vertexProjectId);

    case 'azblob':
      return new AzureBlobFileRepository(
        bucket,
        prefix,
        process.env['AZURE_STORAGE_CONNECTION_STRING'],
      );

    default:
      throw new Error(
        `Unsupported --output-bucket scheme: "${scheme}". Supported schemes: s3, gs, azblob.`,
      );
  }
}
