/**
 * Stable public library API for Vision Lens (formerly the legacy `ai-image-labeling` package).
 * All exports from this file are semver-stable.
 * Deep @vision-lens/core module paths are NOT stable — use this entry point.
 */
export {
  analyzeBatch,
  buildSystemPrompt,
  buildUserPrompt,
  normalizeCategory,
} from '@vision-lens/core/analyzer/batch';
export { createLLMClient } from '@vision-lens/core/analyzer/client';
export type {
  AsyncBatchClient,
  AsyncBatchJobInfo,
  AsyncBatchRequest,
  AsyncBatchResult,
  CompleteOptions,
  CompleteResult,
  ImageInput,
  LLMClient,
} from '@vision-lens/core/analyzer/client';
export { classifyAndSort } from '@vision-lens/core/classifier';
export { loadConfig } from '@vision-lens/core/config';
export type { CategoryConfig, Config, LogFormat, OutputFormat } from '@vision-lens/core/config';
export {
  runBatch,
  runDiff,
  runReport,
  runReorder,
  runSingle,
  runSuggestCategories,
  runWatch,
} from '@vision-lens/core';
export type { DiffSummary, ChangeType, ImageDiff } from '@vision-lens/core/diff';
export { diffCaches } from '@vision-lens/core/diff';
export { buildSessions } from '@vision-lens/core/analyzer/sessions';
export type { SessionBuildResult } from '@vision-lens/core/analyzer/sessions';
export { runConsensus } from '@vision-lens/core/analyzer/consensus';
export type { ConsensusResult } from '@vision-lens/core/analyzer/consensus';
export type { FileRepository } from '@vision-lens/core/fs';
export {
  NodeFileRepository,
  MemoryFileRepository,
  S3FileRepository,
  GCSFileRepository,
  AzureBlobFileRepository,
  createFileRepository,
} from '@vision-lens/core/fs';
export { suggestCategories } from '@vision-lens/core/analyzer/suggest';
export { elements, imageLinks, images, runs } from '@vision-lens/core/reporter/sqlite-schema';
export { CACHE_SCHEMA_VERSION, PLUGIN_API_VERSION } from '@vision-lens/core/types';
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
} from '@vision-lens/core/types';
export { generateEmbeddings } from '@vision-lens/core/analyzer/embeddings';
export type { EmbeddingEntry } from '@vision-lens/core/analyzer/embeddings';
export { cosineSimilarity, rankResults } from '@vision-lens/core/search';
export type { RankedResult } from '@vision-lens/core/search';
export { searchSemantic, searchKeyword } from '@vision-lens/core/search/query';
export type { SearchResult } from '@vision-lens/core/search/query';
export { runSearch } from '@vision-lens/core';
