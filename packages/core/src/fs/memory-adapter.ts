import type { FileRepository } from './port.js';

export class MemoryFileRepository implements FileRepository {
  private files = new Map<string, string | Buffer>();
  private dirs = new Set<string>();

  async listFiles(dir: string): Promise<string[]> {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    return [...this.files.keys()]
      .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
      .map((k) => k.slice(prefix.length));
  }

  async exists(filePath: string): Promise<boolean> {
    return this.files.has(filePath) || this.dirs.has(filePath);
  }

  async ensureDir(dir: string): Promise<void> {
    this.dirs.add(dir);
  }

  async readJson<T>(filePath: string): Promise<T> {
    const content = this.files.get(filePath);
    if (content === undefined) throw new Error(`File not found: ${filePath}`);
    return JSON.parse(content.toString()) as T;
  }

  async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    this.files.set(filePath, JSON.stringify(value, null, 2));
  }

  async writeTextAtomic(filePath: string, content: string): Promise<void> {
    this.files.set(filePath, content);
  }

  async writeBinary(filePath: string, content: Buffer): Promise<void> {
    this.files.set(filePath, content);
  }

  async remove(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }

  /** Test helper: seed a file into the in-memory store. */
  seed(filePath: string, content: string | Buffer): void {
    this.files.set(filePath, content);
  }

  /** Test helper: read a seeded or written file as string. */
  read(filePath: string): string | undefined {
    const v = this.files.get(filePath);
    return v !== undefined ? v.toString() : undefined;
  }
}
