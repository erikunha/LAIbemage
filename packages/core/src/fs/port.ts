import type { AnalysisCache, AnalyzedImage, PartialAnalysisCache } from '../types.js';

export interface FileRepository {
  /** List all filenames (not paths) in a directory. */
  listFiles(dir: string): Promise<string[]>;
  /** Return true if the path exists. */
  exists(filePath: string): Promise<boolean>;
  /** Ensure a directory exists (create recursively if needed). */
  ensureDir(dir: string): Promise<void>;
  /** Read and parse a JSON file. Throws if missing. */
  readJson<T>(filePath: string): Promise<T>;
  /** Atomically write a JSON value (tmp+rename). */
  writeJsonAtomic(filePath: string, value: unknown): Promise<void>;
  /** Atomically write a text file (tmp+rename). */
  writeTextAtomic(filePath: string, content: string): Promise<void>;
  /** Write a binary file. Used for XLSX. */
  writeBinary(filePath: string, content: Buffer): Promise<void>;
  /** Remove a file. No-op if missing. */
  remove(filePath: string): Promise<void>;
}

// Re-export for convenience — callers that type-check against the domain types
// can import from this single location.
export type { AnalysisCache, AnalyzedImage, PartialAnalysisCache };
