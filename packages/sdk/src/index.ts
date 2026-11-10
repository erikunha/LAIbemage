/**
 * Stable public library API for Master Vision (formerly ai-image-labeling).
 * All exports from this file are semver-stable.
 * Deep @master-vision/core module paths are NOT stable — use this entry point.
 */
export {
  analyzeBatch,
  buildSystemPrompt,
  buildUserPrompt,
  normalizeCategory,
} from '@master-vision/core/analyzer/batch';
export { createLLMClient } from '@master-vision/core/analyzer/client';
export type {
  AsyncBatchClient,
  AsyncBatchJobInfo,
  AsyncBatchRequest,
  AsyncBatchResult,
  CompleteOptions,
  CompleteResult,
  ImageInput,
  LLMClient,
} from '@master-vision/core/analyzer/client';
export { classifyAndSort } from '@master-vision/core/classifier';
export { loadConfig } from '@master-vision/core/config';
export type { CategoryConfig, Config, LogFormat, OutputFormat } from '@master-vision/core/config';
export {
  runBatch,
  runDiff,
  runReport,
  runReorder,
  runSingle,
  runSuggestCategories,
  runWatch,
} from '@master-vision/core';
export type { DiffSummary, ChangeType, ImageDiff } from '@master-vision/core/diff';
export { diffCaches } from '@master-vision/core/diff';
export { buildSessions } from '@master-vision/core/analyzer/sessions';
export type { SessionBuildResult } from '@master-vision/core/analyzer/sessions';
export { runConsensus } from '@master-vision/core/analyzer/consensus';
export type { ConsensusResult } from '@master-vision/core/analyzer/consensus';
export type { FileRepository } from '@master-vision/core/fs';
export {
  NodeFileRepository,
  MemoryFileRepository,
  S3FileRepository,
  GCSFileRepository,
  AzureBlobFileRepository,
  createFileRepository,
} from '@master-vision/core/fs';
export { suggestCategories } from '@master-vision/core/analyzer/suggest';
export { elements, imageLinks, images, runs } from '@master-vision/core/reporter/sqlite-schema';
export { CACHE_SCHEMA_VERSION, PLUGIN_API_VERSION } from '@master-vision/core/types';
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
} from '@master-vision/core/types';
export { generateEmbeddings } from '@master-vision/core/analyzer/embeddings';
export type { EmbeddingEntry } from '@master-vision/core/analyzer/embeddings';
export { cosineSimilarity, rankResults } from '@master-vision/core/search';
export type { RankedResult } from '@master-vision/core/search';
export { searchSemantic, searchKeyword } from '@master-vision/core/search/query';
export type { SearchResult } from '@master-vision/core/search/query';
export { runSearch } from '@master-vision/core';
