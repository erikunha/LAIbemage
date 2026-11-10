import { Storage } from '@google-cloud/storage';
import type { FileRepository } from './port.js';

export class GCSFileRepository implements FileRepository {
  private readonly storage: Storage;

  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
    projectId?: string,
  ) {
    this.storage = new Storage({ ...(projectId ? { projectId } : {}) });
  }

  private key(filePath: string): string {
    const relative = filePath.replace(/^\/+/, '');
    return this.prefix ? `${this.prefix}/${relative}` : relative;
  }

  async listFiles(dir: string): Promise<string[]> {
    const dirKey = this.key(dir);
    const keyPrefix = dirKey.endsWith('/') ? dirKey : dirKey + '/';

    const [files] = await this.storage.bucket(this.bucket).getFiles({ prefix: keyPrefix });
    return files
      .map((f) => f.name.slice(keyPrefix.length))
      .filter((name) => name.length > 0 && !name.includes('/'));
  }

  async exists(filePath: string): Promise<boolean> {
    const [result] = await this.storage.bucket(this.bucket).file(this.key(filePath)).exists();
    return result;
  }

  // GCS has no real directories — this is a no-op
  async ensureDir(_dir: string): Promise<void> {
    // no-op
  }

  async readJson<T>(filePath: string): Promise<T> {
    const [content] = await this.storage.bucket(this.bucket).file(this.key(filePath)).download();
    return JSON.parse(content.toString('utf-8')) as T;
  }

  async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    await this.storage
      .bucket(this.bucket)
      .file(this.key(filePath))
      .save(JSON.stringify(value, null, 2), { contentType: 'application/json' });
  }

  async writeTextAtomic(filePath: string, content: string): Promise<void> {
    await this.storage
      .bucket(this.bucket)
      .file(this.key(filePath))
      .save(content, { contentType: 'text/plain' });
  }

  async writeBinary(filePath: string, content: Buffer): Promise<void> {
    await this.storage
      .bucket(this.bucket)
      .file(this.key(filePath))
      .save(content, { contentType: 'application/octet-stream' });
  }

  async remove(filePath: string): Promise<void> {
    try {
      await this.storage.bucket(this.bucket).file(this.key(filePath)).delete();
    } catch (err) {
      // GCS throws a 404 if the file does not exist — treat as no-op, consistent with local impl
      const code = (err as { code?: number }).code;
      if (code === 404) return;
      throw err;
    }
  }
}
