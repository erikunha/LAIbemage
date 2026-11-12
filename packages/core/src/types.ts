export type LinkRelation = 'same_location' | 'same_defect' | 'progression';

/** A temporal cluster of images captured in a single continuous session. */
export interface Session {
  readonly sessionId: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly imageNumbers: number[];
}

export interface ImageLink {
  readonly number: number;
  readonly relation: LinkRelation;
}

/** LLM classification output for a single image. */
export interface AnalysisResult {
  /** Category name matching one of the names in `categories.json`. */
  readonly category: string;
  /** One-sentence human-readable description of the image content (max 200 chars). */
  readonly shortDescription: string;
  /**
   * Detailed description of everything visible (max 250 chars): all objects,
   * colors, spatial layout, lighting, context, conditions. Primary corpus for
   * keyword search. Empty string when analysis failed.
   */
  readonly fullDescription: string;
  /** Key visual elements identified in the image (each max 100 chars). */
  readonly elements: string[];
  /** Self-reported model confidence 0.0–1.0. 0 signals unsupported or skipped. */
  readonly confidence: number;
  /** OCR text visible in document/screenshot images. null means no text detected. */
  readonly extractedText: string | null;
}

export type AsyncJobStatus = 'submitted' | 'polling' | 'complete' | 'failed';

/** On-disk state file written by `--async`; read and updated by `--resume`. */
export interface AsyncJobState {
  readonly jobId: string;
  readonly provider: 'openai' | 'anthropic' | 'azure';
  readonly model: string;
  readonly submittedAt: string;
  status: AsyncJobStatus;
  readonly outputDir: string;
  readonly imageCount: number;
  readonly batchSize: number;
  /** Custom IDs of each batch group in order (e.g. ['batch-0', 'batch-1', ...]). */
  readonly customIds: readonly string[];
  /** Sorted original file names — used to rebuild AnalyzedImage order from results. */
  readonly fileOrder: readonly string[];
}

/** How the `createdAt` timestamp was derived for a file. */
export type ExifSource = 'exif' | 'birthtime' | 'ctime';

/** File path and timestamp metadata collected before any LLM analysis. */
export interface FileWithStats {
  readonly file: string;
  readonly fullPath: string;
  /** Milliseconds since Unix epoch. */
  readonly createdAt: number;
  readonly exifSource: ExifSource;
}

/** A `FileWithStats` enriched with the LLM `AnalysisResult`. */
export interface AnalyzedImage extends FileWithStats {
  readonly analysis: AnalysisResult;
}

/** Final per-image output record written to `analysis_results.json` and the JPEG export. */
export interface ProcessedResult {
  readonly originalFile: string;
  readonly outputFile: string;
  readonly category: string;
  readonly number: number;
  readonly shortDescription: string;
  /** Detailed description for keyword search (max 250 chars). Absent in pre-existing caches. */
  readonly fullDescription?: string;
  readonly elements: string[];
  readonly confidence: number;
  readonly extractedText: string | null;
  readonly timestamp: number;
  readonly relatedImages?: ImageLink[];
  /** Session cluster this image belongs to (set when --session-gap is used). */
  readonly sessionId?: number;
  /** True when two providers disagreed on this image's category (--consensus-providers). */
  readonly lowConsensus?: boolean;
}

/** Increment when the cache format changes in a breaking way. */
export const CACHE_SCHEMA_VERSION = 1;

/**
 * Semver-stable plugin API version. Plugins can assert this at load time.
 * Increment when the Plugin interface changes in a breaking way.
 */
export const PLUGIN_API_VERSION = 1;

/**
 * Plugin interface. A plugin file must `export default` an object conforming to this shape.
 * Each hook is optional — plugins implement only the hooks they need.
 * A failing hook logs a warning but never aborts the run.
 */
export interface Plugin {
  /** Human-readable plugin name used in log messages. */
  readonly name: string;
  /** Called after each image is analysed by the LLM. */
  onImageAnalysed?(result: AnalyzedImage): Promise<void>;
  /** Called after each image is processed (overlay stamped, JPEG exported). */
  onImageProcessed?(result: ProcessedResult): Promise<void>;
  /** Called once after the full run completes and the cache has been written. */
  onRunComplete?(cache: AnalysisCache): Promise<void>;
}

/** A category override applied interactively by the user before processing. */
export interface ReviewOverride {
  readonly file: string;
  readonly originalCategory: string;
  readonly overriddenCategory: string;
}

/** On-disk completed analysis cache written atomically to `analysis_results.json`. */
export interface AnalysisCache {
  readonly schemaVersion: number;
  readonly processedDate: string;
  readonly totalImages: number;
  readonly categories: string[];
  /** SHA-256 (first 12 hex chars) of sorted category names — detects categories.json changes. */
  readonly categoriesHash: string;
  readonly images: ProcessedResult[];
  /** Plugin API version at the time of the run — plugins can assert compatibility. */
  readonly pluginApiVersion?: number;
  /** Category overrides applied via --interactive review before processing. */
  readonly overrides?: ReviewOverride[];
  /** Files excluded by the user during --interactive review. */
  readonly skipped?: string[];
  /** Session clusters computed when --session-gap is used. */
  readonly sessions?: Session[];
}

/** Intermediate cache written after each completed batch for crash recovery. */
export interface PartialAnalysisCache {
  readonly schemaVersion: number;
  readonly startedAt: string;
  /** SHA-256 (first 12 hex chars) of sorted category names at the time the run started. */
  readonly categoriesHash: string;
  readonly images: AnalyzedImage[];
}
