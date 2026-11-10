/**
 * Stable public library API for ai-image-labeling.
 * All exports from this file are semver-stable.
 * Internal module paths (dist/analyzer/batch.js, etc.) are NOT stable — use this entry point.
 */
export {
  analyzeBatch,
  buildSystemPrompt,
  buildUserPrompt,
  normalizeCategory,
} from './analyzer/batch.js';
export { createLLMClient } from './analyzer/client.js';
export type {
  AsyncBatchClient,
  AsyncBatchJobInfo,
  AsyncBatchRequest,
  AsyncBatchResult,
  CompleteOptions,
  CompleteResult,
  ImageInput,
  LLMClient,
} from './analyzer/client.js';
export { classifyAndSort } from './classifier/index.js';
export { loadConfig } from './config/index.js';
export type { CategoryConfig, Config, LogFormat, OutputFormat } from './config/index.js';
export {
  runBatch,
  runDiff,
  runReport,
  runReorder,
  runSingle,
  runSuggestCategories,
  runWatch,
} from './index.js';
export type { DiffSummary, ChangeType, ImageDiff } from './diff/index.js';
export { diffCaches } from './diff/index.js';
export { buildSessions } from './analyzer/sessions.js';
export type { SessionBuildResult } from './analyzer/sessions.js';
export { runConsensus } from './analyzer/consensus.js';
export type { ConsensusResult } from './analyzer/consensus.js';
export type { FileRepository } from './fs/index.js';
export {
  NodeFileRepository,
  MemoryFileRepository,
  S3FileRepository,
  GCSFileRepository,
  AzureBlobFileRepository,
  createFileRepository,
} from './fs/index.js';
export { suggestCategories } from './analyzer/suggest.js';
export { elements, imageLinks, images, runs } from './reporter/sqlite-schema.js';
export { CACHE_SCHEMA_VERSION, PLUGIN_API_VERSION } from './types.js';
export type {
  AnalysisCache,
  AnalysisResult,
  AnalyzedImage,
  AsyncJobState,
  FileWithStats,
  ImageLink,
  LinkRelation,
  PartialAnalysisCache,
  Plugin,
  ProcessedResult,
  Session,
} from './types.js';
export { generateEmbeddings } from './analyzer/embeddings.js';
export type { EmbeddingEntry } from './analyzer/embeddings.js';
export { cosineSimilarity, rankResults } from './search/index.js';
export type { RankedResult } from './search/index.js';
export { searchSemantic, searchKeyword } from './search/query.js';
export type { SearchResult } from './search/query.js';
export { runSearch } from './index.js';
