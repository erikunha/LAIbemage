import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type { FileRepository } from './port.js';

export class S3FileRepository implements FileRepository {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
    region = 'us-east-1',
    credentials?: { accessKeyId: string; secretAccessKey: string },
  ) {
    this.client = new S3Client({
      region,
      ...(credentials ? { credentials } : {}),
    });
  }

  private key(filePath: string): string {
    // Strip leading slashes so we get a clean relative key
    const relative = filePath.replace(/^\/+/, '');
    return this.prefix ? `${this.prefix}/${relative}` : relative;
  }

  async listFiles(dir: string): Promise<string[]> {
    // Build a prefix that represents the directory
    const dirKey = this.key(dir);
    const keyPrefix = dirKey.endsWith('/') ? dirKey : dirKey + '/';

    const command = new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: keyPrefix,
      Delimiter: '/',
    });
    const response = await this.client.send(command);
    const contents = response.Contents ?? [];

    // Return only the final filename component (no slashes / directory parts)
    return contents
      .map((obj) => obj.Key ?? '')
      .filter((k) => k.length > keyPrefix.length)
      .map((k) => k.slice(keyPrefix.length))
      .filter((name) => name.length > 0 && !name.includes('/'));
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }),
      );
      return true;
    } catch (err) {
      const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } }).name;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (code === 'NotFound' || code === 'NoSuchKey' || status === 404) {
        return false;
      }
      throw err;
    }
  }

  // S3 has no real directories — this is a no-op
  async ensureDir(_dir: string): Promise<void> {
    // no-op
  }

  async readJson<T>(filePath: string): Promise<T> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }),
    );
    const body = response.Body as Readable | undefined;
    if (!body) throw new Error(`S3 object body is empty: ${filePath}`);

    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    return JSON.parse(text) as T;
  }

  async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    // S3 PutObject is atomic by nature — no tmp needed
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(filePath),
        Body: JSON.stringify(value, null, 2),
        ContentType: 'application/json',
      }),
    );
  }

  async writeTextAtomic(filePath: string, content: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(filePath),
        Body: content,
        ContentType: 'text/plain',
      }),
    );
  }

  async writeBinary(filePath: string, content: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(filePath),
        Body: content,
        ContentType: 'application/octet-stream',
      }),
    );
  }

  async remove(filePath: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(filePath) }),
    );
  }
}
