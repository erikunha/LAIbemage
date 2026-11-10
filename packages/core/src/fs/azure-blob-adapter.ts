import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import type { FileRepository } from './port.js';

export class AzureBlobFileRepository implements FileRepository {
  private readonly serviceClient: BlobServiceClient;

  constructor(
    private readonly container: string,
    private readonly prefix: string,
    connectionString?: string,
  ) {
    if (connectionString) {
      this.serviceClient = BlobServiceClient.fromConnectionString(connectionString);
    } else {
      const accountName = process.env['AZURE_STORAGE_ACCOUNT'] ?? '';
      const accountKey = process.env['AZURE_STORAGE_KEY'] ?? '';
      this.serviceClient = new BlobServiceClient(
        `https://${accountName}.blob.core.windows.net`,
        new StorageSharedKeyCredential(accountName, accountKey),
      );
    }
  }

  private blobName(filePath: string): string {
    const relative = filePath.replace(/^\/+/, '');
    return this.prefix ? `${this.prefix}/${relative}` : relative;
  }

  private containerClient() {
    return this.serviceClient.getContainerClient(this.container);
  }

  async listFiles(dir: string): Promise<string[]> {
    const dirKey = this.blobName(dir);
    const keyPrefix = dirKey.endsWith('/') ? dirKey : dirKey + '/';

    const results: string[] = [];
    for await (const blob of this.containerClient().listBlobsFlat({ prefix: keyPrefix })) {
      const name = blob.name.slice(keyPrefix.length);
      if (name.length > 0 && !name.includes('/')) {
        results.push(name);
      }
    }
    return results;
  }

  async exists(filePath: string): Promise<boolean> {
    return this.containerClient().getBlobClient(this.blobName(filePath)).exists();
  }

  // Azure Blob has no real directories — this is a no-op
  async ensureDir(_dir: string): Promise<void> {
    // no-op
  }

  async readJson<T>(filePath: string): Promise<T> {
    const blobClient = this.containerClient().getBlobClient(this.blobName(filePath));
    const downloadResponse = await blobClient.download();
    const body = downloadResponse.readableStreamBody;
    if (!body) throw new Error(`Azure Blob body is empty: ${filePath}`);

    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as Uint8Array));
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    return JSON.parse(text) as T;
  }

  async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const content = JSON.stringify(value, null, 2);
    const blockClient = this.containerClient().getBlockBlobClient(this.blobName(filePath));
    await blockClient.upload(content, Buffer.byteLength(content, 'utf-8'), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
    });
  }

  async writeTextAtomic(filePath: string, content: string): Promise<void> {
    const blockClient = this.containerClient().getBlockBlobClient(this.blobName(filePath));
    await blockClient.upload(content, Buffer.byteLength(content, 'utf-8'), {
      blobHTTPHeaders: { blobContentType: 'text/plain' },
    });
  }

  async writeBinary(filePath: string, content: Buffer): Promise<void> {
    const blockClient = this.containerClient().getBlockBlobClient(this.blobName(filePath));
    await blockClient.upload(content, content.length, {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
    });
  }

  async remove(filePath: string): Promise<void> {
    try {
      await this.containerClient().getBlobClient(this.blobName(filePath)).deleteIfExists();
    } catch {
      // deleteIfExists already handles 404 — only other errors should propagate
    }
  }
}
