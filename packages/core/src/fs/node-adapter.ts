import fs from 'fs-extra';
import type { FileRepository } from './port.js';

export class NodeFileRepository implements FileRepository {
  async listFiles(dir: string): Promise<string[]> {
    return fs.readdir(dir);
  }

  async exists(filePath: string): Promise<boolean> {
    return fs.pathExists(filePath);
  }

  async ensureDir(dir: string): Promise<void> {
    await fs.ensureDir(dir);
  }

  async readJson<T>(filePath: string): Promise<T> {
    return fs.readJSON(filePath) as Promise<T>;
  }

  async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fs.writeJSON(tmp, value, { spaces: 2 });
    await fs.rename(tmp, filePath);
  }

  async writeTextAtomic(filePath: string, content: string): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await fs.writeFile(tmp, content, 'utf8');
    await fs.rename(tmp, filePath);
  }

  async writeBinary(filePath: string, content: Buffer): Promise<void> {
    await fs.writeFile(filePath, content);
  }

  async remove(filePath: string): Promise<void> {
    await fs.remove(filePath);
  }
}
