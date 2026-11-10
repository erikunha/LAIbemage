import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pLimit from 'p-limit';
import type { FileRepository } from './fs/index.js';
import { NodeFileRepository, createFileRepository } from './fs/index.js';
import { resumeAsyncBatch, submitAsyncBatch } from './analyzer/async-batch.js';
import { createAsyncBatchClient, createLLMClient } from './analyzer/client.js';
import { generateEmbeddings } from './analyzer/embeddings.js';
import { suggestCategories } from './analyzer/suggest.js';
import { linkImages } from './analyzer/linker.js';
import { buildSessions } from './analyzer/sessions.js';
import { runConsensus } from './analyzer/consensus.js';
import { deduplicateImages } from './analyzer/dedup.js';
import { analyzeImages } from './analyzer/index.js';
import { buildIndex, defaultIndexPath } from './search/index.js';
import { searchSemantic, searchKeyword } from './search/query.js';
import type { SearchResult } from './search/query.js';
import { classifyAndSort } from './classifier/index.js';
import type { CategoryConfig, Config } from './config/index.js';
import { validateStartup } from './config/index.js';
import {
  fireOnImageAnalysed,
  fireOnImageProcessed,
  fireOnRunComplete,
  loadPlugins,
} from './plugin/index.js';
import { processImage } from './processor/index.js';
import { reorderImages } from './processor/reorder.js';
import { generateHtmlReport } from './reporter/index.js';
import { buildReporters } from './reporter/factory.js';
import { buildFeedbackNote } from './utils/feedback.js';
import { fireWebhook } from './utils/webhook.js';
import { runInteractiveReview } from './reviewer/index.js';
import type {
  AnalysisCache,
  AnalyzedImage,
  AsyncJobState,
  FileWithStats,
  PartialAnalysisCache,
  Plugin,
  ProcessedResult,
  ReviewOverride,
  Session,
} from './types.js';
import { CACHE_SCHEMA_VERSION, PLUGIN_API_VERSION } from './types.js';
import { diffCaches } from './diff/index.js';
export type { DiffSummary } from './diff/index.js';
import { printCostEstimate } from './utils/cost.js';
import { getImageTimestamp } from './utils/exif.js';
import { logger } from './utils/logger.js';
import { validateImageMimeType } from './utils/mime.js';
import {
  printSummaryTable,
  startProgress,
  stopProgress,
  updateProgress,
} from './utils/progress.js';

const IMAGE_REGEX = /\.(jpe?g|png|webp|tiff?|avif)$/i;
const CACHE_FILE_NAME = 'analysis_results.json';
const PARTIAL_CACHE_FILE_NAME = '.analysis_cache_partial.json';
const ASYNC_JOB_FILE_NAME = 'analysis_job.json';

function resolveEmbeddingModel(config: Config): string {
  switch (config.provider) {
    case 'google':
    case 'vertex':
      return 'text-embedding-004';
    case 'ollama':
      return 'nomic-embed-text';
    default:
      return 'text-embedding-3-small';
  }
}

function computeCategoriesHash(categoryConfig: CategoryConfig): string {
  const names = categoryConfig.categories
    .map((c) => c.name)
    .sort()
    .join(',');
  return createHash('sha256').update(names).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// runBatch
// ---------------------------------------------------------------------------
export async function runBatch(
  config: Config,
  fileRepo: FileRepository = createFileRepository(config),
): Promise<void> {
  const startedAt = Date.now();

  // Phase 3.2 — cost estimate: count images and exit without making API calls
  if (config.estimate) {
    const allFiles = await fileRepo.listFiles(config.inputDir).catch(() => [] as string[]);
    const imageCount = allFiles.filter((f) => IMAGE_REGEX.test(f)).length;
    printCostEstimate(imageCount, config.batchSize);
    return;
  }

  // Phase 1.3 — startup validation (fails fast with a one-line message)
  await validateStartup(config);

  await fileRepo.ensureDir(config.inputDir);
  await fileRepo.ensureDir(config.outputDir);

  // Load plugins (Phase 5.3)
  const plugins: Plugin[] = await loadPlugins(config.plugins);

  // Collect input images
  const t0Collection = Date.now();
  const allFiles = await fileRepo.listFiles(config.inputDir);
  const imageFiles = allFiles.filter((f) => IMAGE_REGEX.test(f)).sort();

  if (imageFiles.length === 0) {
    logger.warn(`No images found in ${config.inputDir}`);
    return;
  }

  logger.info(`\n Found ${imageFiles.length} image(s) in ${config.inputDir}`);

  // 2.13 — MIME type validation via magic bytes (serial to avoid EMFILE)
  const validatedFiles: string[] = [];
  for (const file of imageFiles) {
    const fullPath = path.join(config.inputDir, file);
    const { valid, detectedMime } = await validateImageMimeType(fullPath);
    if (valid) {
      validatedFiles.push(file);
    } else {
      logger.warn(
        `  Skipping ${file}: not a supported image (detected: ${detectedMime ?? 'unknown'})`,
      );
    }
  }

  if (validatedFiles.length === 0) {
    logger.warn(`No valid images found in ${config.inputDir}`);
    return;
  }

  if (validatedFiles.length < imageFiles.length) {
    logger.info(
      `\n ${validatedFiles.length} valid image(s) after MIME check (${imageFiles.length - validatedFiles.length} skipped)`,
    );
  }

  // Phase 1.2 — Build FileWithStats sorted by EXIF/birthtime/ctime
  // 1.10 — cap at 32 concurrent reads to avoid EMFILE on large datasets
  const t0Exif = Date.now();
  const exifLimit = pLimit(32);
  const filesWithStats: FileWithStats[] = await Promise.all(
    validatedFiles.map((file) =>
      exifLimit(async () => {
        const fullPath = path.join(config.inputDir, file);
        const { createdAt, exifSource } = await getImageTimestamp(fullPath);
        return { file, fullPath, createdAt, exifSource };
      }),
    ),
  );
  filesWithStats.sort((a, b) => a.createdAt - b.createdAt);
  const t1Exif = Date.now();

  // Log EXIF sourcing summary
  const exifCount = filesWithStats.filter((f) => f.exifSource === 'exif').length;
  const fallbackCount = filesWithStats.length - exifCount;
  if (exifCount > 0 || fallbackCount > 0) {
    logger.verbose(
      ` Timestamps: ${exifCount} from EXIF, ${fallbackCount} from filesystem fallback`,
    );
  }

  const partialCachePath = path.join(config.outputDir, PARTIAL_CACHE_FILE_NAME);
  const asyncJobFilePath = path.join(config.outputDir, ASYNC_JOB_FILE_NAME);

  // ---------------------------------------------------------------------------
  // --async: submit batch job and exit
  // ---------------------------------------------------------------------------
  if (config.asyncBatch) {
    const asyncClient = createAsyncBatchClient(config);
    if (!asyncClient) {
      logger.warn(
        `[warn] --async is not supported for provider "${config.provider}" (supported: openai, anthropic, azure). Running synchronously instead.`,
      );
    } else {
      const state = await submitAsyncBatch(filesWithStats, config, asyncClient);
      await fileRepo.writeJsonAtomic(asyncJobFilePath, state);
      logger.info(
        `\n Job submitted: ${state.jobId}\n` +
          `  Job file: ${asyncJobFilePath}\n` +
          `\n Run with --resume when the job completes to collect results.`,
      );
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // --resume: poll existing async job and collect results
  // ---------------------------------------------------------------------------
  if (config.resumeBatch) {
    if (!(await fileRepo.exists(asyncJobFilePath))) {
      throw new Error(`--resume requested but no job file found: ${asyncJobFilePath}`);
    }
    const state = await fileRepo.readJson<AsyncJobState>(asyncJobFilePath);
    const asyncClient = createAsyncBatchClient(config);
    if (!asyncClient) {
      throw new Error(
        `Provider "${config.provider}" does not support async batching. Check your --provider flag.`,
      );
    }
    const analysisResults = await resumeAsyncBatch(state, asyncClient);

    // Map results back to filesWithStats using fileOrder
    const fileOrderMap = new Map(state.fileOrder.map((f, i) => [f, i]));
    const orderedFiles = [...filesWithStats].sort((a, b) => {
      const ai = fileOrderMap.get(a.file) ?? Infinity;
      const bi = fileOrderMap.get(b.file) ?? Infinity;
      return ai - bi;
    });

    const analyzedFromAsync: AnalyzedImage[] = orderedFiles.map((f, i) => ({
      ...f,
      analysis: analysisResults[i] ?? {
        category: 'unknown',
        shortDescription: 'unanalyzed image',
        fullDescription: '',
        elements: [],
        confidence: 0,
        extractedText: null,
      },
    }));

    // Re-sort by createdAt for consistent ordering into classify/process pipeline
    analyzedFromAsync.sort((a, b) => a.createdAt - b.createdAt);

    // Remove the job file now that results are collected
    await fileRepo.remove(asyncJobFilePath);

    // Classify and process images from the completed async job
    const { grouped: resumeGrouped, sortedCategories: resumeSortedCategories } = classifyAndSort(
      analyzedFromAsync,
      config,
    );
    const resumeProcessedResults: ProcessedResult[] = [];
    let resumeSequenceNumber = 1;
    logger.info('\n Processing and exporting images...');
    for (const category of resumeSortedCategories) {
      const group = resumeGrouped[category] ?? [];
      for (const img of group) {
        const { outputName } = await processImage(img, resumeSequenceNumber, config);
        const processedResult: ProcessedResult = {
          originalFile: img.file,
          outputFile: outputName,
          category: img.analysis.category,
          number: resumeSequenceNumber,
          shortDescription: img.analysis.shortDescription,
          elements: img.analysis.elements,
          confidence: img.analysis.confidence,
          extractedText: img.analysis.extractedText,
          timestamp: img.createdAt,
        };
        resumeProcessedResults.push(processedResult);
        resumeSequenceNumber++;
      }
    }

    await postAnalysisPipeline(
      resumeProcessedResults,
      resumeSortedCategories,
      config,
      plugins,
      partialCachePath,
      startedAt,
      {
        overrideCount: 0,
        duplicatesSkipped: 0,
        apiCalls: state.customIds.length,
        totalTokensUsed: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        partialFailures: 0,
        reviewOverrides: [],
        reviewSkipped: [],
        // No per-step timings for the resume path
        timings: undefined,
      },
      fileRepo,
    );
    return;
  }

  // Run or restore analysis
  let analyzedImages: AnalyzedImage[];
  let partialFailures = 0;
  let totalTokensUsed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let duplicatesSkipped = 0;
  let apiCalls = 0;
  let overrideCount = 0;
  let tDedupMs = 0;
  let tAnalysisMs = 0;
  const consensusLowFiles = new Set<string>();

  if (config.skipAnalysis || config.forceSkipAnalysis) {
    const cacheFile = path.join(config.outputDir, CACHE_FILE_NAME);
    if (!(await fileRepo.exists(cacheFile))) {
      throw new Error(`--skip-analysis requested but cache not found: ${cacheFile}`);
    }
    logger.info(` Using cached analysis from ${cacheFile}`);
    const cache = await fileRepo.readJson<AnalysisCache>(cacheFile);

    // warn if categories.json has changed since the cache was produced (suppressed by --force-skip-analysis)
    const currentHash = computeCategoriesHash(config.categoryConfig);
    if (!config.forceSkipAnalysis && cache.categoriesHash && cache.categoriesHash !== currentHash) {
      logger.warn(
        `[warn] categories.json has changed since this cache was created.\n` +
          `       Cached: ${cache.categoriesHash}  Current: ${currentHash}\n` +
          `       Re-run without --skip-analysis to reclassify, or pass --force-skip-analysis to suppress this warning.`,
      );
    }

    // Rebuild analyzedImages from cache
    analyzedImages = cache.images.map((r) => {
      const original = filesWithStats.find((f) => f.file === r.originalFile) ?? {
        file: r.originalFile,
        fullPath: path.join(config.inputDir, r.originalFile),
        createdAt: r.timestamp,
        exifSource: 'ctime' as const,
      };
      return {
        ...original,
        analysis: {
          category: r.category,
          shortDescription: r.shortDescription,
          fullDescription: r.fullDescription ?? '',
          elements: r.elements,
          confidence: r.confidence ?? 0,
          extractedText: r.extractedText ?? null,
        },
      };
    });
  } else {
    // Phase 1.1 — Load partial cache to resume from checkpoint
    let alreadyAnalyzed: AnalyzedImage[] = [];
    if (await fileRepo.exists(partialCachePath)) {
      try {
        const partial = await fileRepo.readJson<PartialAnalysisCache>(partialCachePath);
        const currentHash = computeCategoriesHash(config.categoryConfig);
        if (partial.schemaVersion === CACHE_SCHEMA_VERSION && Array.isArray(partial.images)) {
          if (partial.categoriesHash && partial.categoriesHash !== currentHash) {
            logger.warn(' Partial cache was produced with different categories — starting fresh.');
            await fileRepo.remove(partialCachePath);
          } else {
            alreadyAnalyzed = partial.images;
            logger.info(
              ` Resuming from checkpoint: ${alreadyAnalyzed.length}/${filesWithStats.length} images already analyzed.`,
            );
          }
        } else {
          logger.warn(' Partial cache schema mismatch — starting fresh.');
          await fileRepo.remove(partialCachePath);
        }
      } catch {
        logger.warn(' Could not read partial cache — starting fresh.');
        await fileRepo.remove(partialCachePath);
      }
    }

    const alreadyDoneFiles = new Set(alreadyAnalyzed.map((a) => a.file));
    const remainingFiles = filesWithStats.filter((f) => !alreadyDoneFiles.has(f.file));

    // 4.1 — Skip near-identical burst frames before sending to LLM
    const t0Dedup = Date.now();
    const { unique: uniqueFiles, duplicateMap } = await deduplicateImages(
      remainingFiles,
      config.dedupeThreshold,
    );
    const t1Dedup = Date.now();
    tDedupMs = t1Dedup - t0Dedup;
    duplicatesSkipped = duplicateMap.size;
    apiCalls = Math.ceil(uniqueFiles.length / config.batchSize);
    if (duplicateMap.size > 0) {
      logger.info(
        ` Deduplication: ${duplicateMap.size} near-duplicate(s) skipped (${uniqueFiles.length} unique image(s) to analyze)`,
      );
    }

    // Phase 1.1 — Flush partial cache after each completed batch
    const flushPartialCache = async (
      processedCount: number,
      results: import('./types.js').AnalysisResult[],
    ): Promise<void> => {
      const newImages: AnalyzedImage[] = uniqueFiles.slice(0, processedCount).map((f, i) => ({
        ...f,
        analysis: results[i] ?? {
          category: 'unknown',
          shortDescription: 'unanalyzed image',
          fullDescription: '',
          elements: [],
          confidence: 0,
          extractedText: null,
        },
      }));
      const partial: PartialAnalysisCache = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        startedAt: new Date(startedAt).toISOString(),
        categoriesHash: computeCategoriesHash(config.categoryConfig),
        images: [...alreadyAnalyzed, ...newImages],
      };
      // 1.9 — atomic write (tmp+rename) so a crash mid-write never produces a corrupt checkpoint
      try {
        await fileRepo.writeJsonAtomic(partialCachePath, partial);
      } catch (err) {
        logger.warn(
          `Could not write checkpoint (${(err as NodeJS.ErrnoException).code ?? 'unknown error'}). Progress will not be resumable if interrupted.`,
        );
      }
    };

    // Phase 1.4 — SIGINT / SIGTERM handler
    const handleSignal = (): void => {
      stopProgress();
      logger.warn(
        '\nRun interrupted. Resume with --skip-analysis or re-run to continue from checkpoint.',
      );
      process.exit(130);
    };
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);

    // Learn pass: load previous cache overrides to inject as few-shot examples
    let feedbackNote = '';
    if (config.learn) {
      const prevCacheFile = path.join(config.outputDir, CACHE_FILE_NAME);
      try {
        const prevCache = await fileRepo.readJson<AnalysisCache>(prevCacheFile);
        feedbackNote = buildFeedbackNote(prevCache.overrides ?? []);
        if (feedbackNote) logger.info('\n [learn] Injecting override patterns into prompt.');
      } catch {
        logger.verbose(' [learn] No previous cache found — skipping feedback injection.');
      }
    }

    const totalBatches = Math.ceil(uniqueFiles.length / config.batchSize);
    if (uniqueFiles.length > 0) {
      startProgress(filesWithStats.length, totalBatches);
    }

    try {
      const t0Analysis = Date.now();

      // H11.3 — Multi-model consensus: run two providers in parallel when configured
      let analysisFn: typeof analyzeImages;
      if (config.consensusProviders && config.consensusProviders.length >= 2) {
        logger.info(`\n Running consensus analysis (${config.consensusProviders.join(' + ')})...`);
        analysisFn = async (files, cfg) => {
          const result = await runConsensus(files, cfg, [...config.consensusProviders!]);
          for (const f of result.lowConsensusFiles) consensusLowFiles.add(f);
          return { images: result.images, overrideCount: 0 };
        };
      } else {
        analysisFn = analyzeImages;
      }

      const { images: newlyAnalyzed, overrideCount: tc } = await analysisFn(
        uniqueFiles,
        config,
        (processed, batch, tokensUsed, inputTokens, outputTokens) => {
          totalTokensUsed += tokensUsed;
          totalInputTokens += inputTokens;
          totalOutputTokens += outputTokens;
          updateProgress(alreadyAnalyzed.length + processed, batch, tokensUsed);
        },
        flushPartialCache,
        feedbackNote,
      );
      overrideCount = tc;
      const t1Analysis = Date.now();
      tAnalysisMs = t1Analysis - t0Analysis;

      // Merge duplicate frames back in original order with representative's analysis
      const uniqueAnalyzedMap = new Map(newlyAnalyzed.map((img) => [img.file, img]));
      const allNewlyAnalyzed: AnalyzedImage[] = remainingFiles.map((f) => {
        const analyzed = uniqueAnalyzedMap.get(f.file);
        if (analyzed) return analyzed;
        const repFile = duplicateMap.get(f.file);
        const rep = repFile !== undefined ? uniqueAnalyzedMap.get(repFile) : undefined;
        return {
          ...f,
          analysis: rep?.analysis ?? {
            category: 'unknown',
            shortDescription: 'unanalyzed image',
            fullDescription: '',
            elements: [],
            confidence: 0,
            extractedText: null,
          },
        };
      });

      analyzedImages = [...alreadyAnalyzed, ...allNewlyAnalyzed];

      // Fire onImageAnalysed plugin hook for each newly analysed image
      for (const img of allNewlyAnalyzed) {
        await fireOnImageAnalysed(plugins, img);
      }

      // Count partial failures (images that failed API analysis — not just unknown classification)
      partialFailures = allNewlyAnalyzed.filter(
        (img) =>
          img.analysis.category === 'unknown' &&
          img.analysis.shortDescription === 'unanalyzed image',
      ).length;
    } finally {
      stopProgress();
      process.off('SIGINT', handleSignal);
      process.off('SIGTERM', handleSignal);
    }
  }

  // Interactive review (if --interactive and stdin is a TTY)
  let reviewOverrides: ReviewOverride[] = [];
  let reviewSkipped: string[] = [];
  if (config.interactive) {
    const reviewResult = await runInteractiveReview(analyzedImages, config);
    analyzedImages = reviewResult.images;
    reviewOverrides = reviewResult.overrides;
    reviewSkipped = reviewResult.skipped;
  }

  // Classify and sort
  const t0Classify = Date.now();
  const { grouped, sortedCategories } = classifyAndSort(analyzedImages, config);
  const tClassifyMs = Date.now() - t0Classify;

  // Process all images — fireOnImageProcessed is deferred to postAnalysisPipeline
  // so plugins always see relatedImages after the --link pass (H7.5)
  const processedResults: ProcessedResult[] = [];
  let sequenceNumber = 1;

  logger.info('\n Processing and exporting images...');

  const t0Processing = Date.now();

  for (const category of sortedCategories) {
    const group = grouped[category] ?? [];
    for (const img of group) {
      const { outputName } = await processImage(img, sequenceNumber, config);
      const processedResult: ProcessedResult = {
        originalFile: img.file,
        outputFile: outputName,
        category: img.analysis.category,
        number: sequenceNumber,
        shortDescription: img.analysis.shortDescription,
        ...(img.analysis.fullDescription ? { fullDescription: img.analysis.fullDescription } : {}),
        elements: img.analysis.elements,
        confidence: img.analysis.confidence,
        extractedText: img.analysis.extractedText,
        timestamp: img.createdAt,
        ...(consensusLowFiles.has(img.file) ? { lowConsensus: true } : {}),
      };
      processedResults.push(processedResult);
      sequenceNumber++;
    }
  }
  const tProcessingMs = Date.now() - t0Processing;

  await postAnalysisPipeline(
    processedResults,
    sortedCategories,
    config,
    plugins,
    partialCachePath,
    startedAt,
    {
      overrideCount,
      duplicatesSkipped,
      apiCalls,
      totalTokensUsed,
      totalInputTokens,
      totalOutputTokens,
      partialFailures,
      reviewOverrides,
      reviewSkipped,
      timings: config.timing
        ? {
            collectionMs: t0Exif - t0Collection,
            exifMs: t1Exif - t0Exif,
            dedupMs: tDedupMs,
            analysisMs: tAnalysisMs,
            classifyMs: tClassifyMs,
            processingMs: tProcessingMs,
          }
        : undefined,
    },
    fileRepo,
  );

  // H9.1 / H16.5 — Generate and persist embeddings when --embed is set
  if (config.embed && processedResults.length > 0 && !config.dryRun) {
    logger.info('\n Generating text embeddings...');
    const embeddings = await generateEmbeddings(processedResults, config);
    if (embeddings.length > 0) {
      const dimensions = embeddings[0]!.vector.length;
      const embeddingModel = resolveEmbeddingModel(config);
      const indexPath = defaultIndexPath(config.outputDir);
      await buildIndex(embeddings, indexPath, embeddingModel, dimensions);
      logger.info(` Embedding index written to ${indexPath}`);
    }
  }
}

// ---------------------------------------------------------------------------
// postAnalysisPipeline — shared post-processing steps for both the normal
// path and the --resume path (H7.4).  Runs:
//   1. --link-images pass (populates relatedImages)
//   2. fireOnImageProcessed hook per image (H7.5 — after relatedImages is set)
//   3. Active-learn queue write
//   4. Atomic cache write (analysis_results.json)
//   5. Optional CSV / XLSX / SQLite reporters
//   6. fireOnRunComplete plugin hook
//   7. Partial-cache cleanup
//   8. Summary table print
//   9. process.exitCode = 2 on partial failures
// ---------------------------------------------------------------------------

interface PostAnalysisStats {
  readonly overrideCount: number;
  readonly duplicatesSkipped: number;
  readonly apiCalls: number;
  readonly totalTokensUsed: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly partialFailures: number;
  readonly reviewOverrides: ReviewOverride[];
  readonly reviewSkipped: string[];
  /** Per-step wall-time values from before the pipeline; cacheWriteMs is measured here. */
  readonly timings?: {
    readonly collectionMs: number;
    readonly exifMs: number;
    readonly dedupMs: number;
    readonly analysisMs: number;
    readonly classifyMs: number;
    readonly processingMs: number;
  };
}

async function postAnalysisPipeline(
  processedResults: ProcessedResult[],
  sortedCategories: string[],
  config: Config,
  plugins: Plugin[],
  partialCachePath: string,
  startedAt: number,
  stats: PostAnalysisStats,
  fileRepo: FileRepository = new NodeFileRepository(),
): Promise<void> {
  const {
    overrideCount,
    duplicatesSkipped,
    apiCalls,
    totalTokensUsed,
    totalInputTokens,
    totalOutputTokens,
    partialFailures,
    reviewOverrides,
    reviewSkipped,
    timings,
  } = stats;

  // 1. Cross-image linking pass (--link) — must run before onImageProcessed so
  //    plugins see relatedImages (H7.5)
  if (config.linkImages && !config.dryRun) {
    logger.info('\n Running cross-image linking pass...');
    const linkerClient = createLLMClient(config);
    const linksMap = await linkImages(
      processedResults,
      linkerClient,
      config.linkWindowDays,
      config.maxRetries,
      config.retryDelayMs,
    );
    processedResults = processedResults.map((r) => {
      const links = linksMap.get(r.number);
      return links && links.length > 0 ? { ...r, relatedImages: links } : r;
    });
  }

  // 1b. Session reconstruction (--session-gap): cluster images into sessions by time gap
  let sessions: Session[] | undefined;
  if (config.sessionGapMinutes && config.sessionGapMinutes > 0) {
    const { sessions: builtSessions, sessionMap } = buildSessions(
      processedResults,
      config.sessionGapMinutes,
    );
    sessions = builtSessions;
    processedResults = processedResults.map((r) => {
      const sid = sessionMap.get(r.number);
      return sid !== undefined ? { ...r, sessionId: sid } : r;
    });
    logger.info(
      `\n Sessions: ${sessions.length} session(s) identified (gap: ${config.sessionGapMinutes} min)`,
    );
  }

  // 2. Fire onImageProcessed for each result — after relatedImages is set (H7.5)
  for (const result of processedResults) {
    await fireOnImageProcessed(plugins, result);
  }

  // 3. Active learning queue — write before cache so it's available even on dry-run
  if (config.activeLearnQueue) {
    const lowConfidence = processedResults.filter(
      (r) => r.category === 'unknown' || r.confidence < 0.5,
    );
    if (lowConfidence.length > 0) {
      const queue = {
        generatedAt: new Date().toISOString(),
        total: processedResults.length,
        queued: lowConfidence.length,
        confidenceThreshold: 0.5,
        images: lowConfidence.map((r) => ({
          number: r.number,
          file: r.originalFile,
          outputFile: r.outputFile,
          category: r.category,
          confidence: r.confidence,
          shortDescription: r.shortDescription,
        })),
      };
      const queuePath = path.join(config.outputDir, 'active_learning_queue.json');
      await fileRepo.writeJsonAtomic(queuePath, queue);
      logger.info(
        `\n Active learning: ${lowConfidence.length}/${processedResults.length} image(s) below threshold → ${queuePath}`,
      );
    } else {
      logger.info(
        '\n Active learning: all images classified with high confidence — no queue generated.',
      );
    }
  }

  // 4. Save final analysis cache — atomic write + categories hash
  const t0CacheWrite = Date.now();
  let finalCache: AnalysisCache | null = null;
  if (config.outputFormat !== 'none') {
    const cache: AnalysisCache = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      processedDate: new Date().toISOString(),
      totalImages: processedResults.length,
      categories: sortedCategories,
      categoriesHash: computeCategoriesHash(config.categoryConfig),
      images: processedResults,
      ...(plugins.length > 0 ? { pluginApiVersion: PLUGIN_API_VERSION } : {}),
      ...(reviewOverrides.length > 0 ? { overrides: reviewOverrides } : {}),
      ...(reviewSkipped.length > 0 ? { skipped: reviewSkipped } : {}),
      ...(sessions && sessions.length > 0 ? { sessions } : {}),
    };
    finalCache = cache;
    const cacheFile = path.join(config.outputDir, CACHE_FILE_NAME);
    await fileRepo.writeJsonAtomic(cacheFile, cache);
    logger.info(`\n Results saved to ${cacheFile}`);

    // 5. Optional reporters
    const reporters = buildReporters(config);
    for (const reporter of reporters) {
      await reporter.write(cache, config.outputDir);
      logger.info(` ${reporter.format.toUpperCase()} saved to ${config.outputDir}`);
    }
  }
  const tCacheWriteMs = Date.now() - t0CacheWrite;

  // 6. Fire onRunComplete plugin hook (after atomic cache write)
  if (finalCache !== null) {
    await fireOnRunComplete(plugins, finalCache);
  }

  // 6b. Fire webhook (after plugin hooks, before summary)
  if (config.webhookUrl && finalCache !== null) {
    await fireWebhook(config.webhookUrl, finalCache);
  }

  // 7. Remove partial cache only after the atomic rename succeeds
  if (await fileRepo.exists(partialCachePath)) {
    await fileRepo.remove(partialCachePath);
  }

  // 8. Summary table
  const unknownCount = processedResults.filter((r) => r.category === 'unknown').length;
  const withConfidence = processedResults.filter((r) => r.confidence > 0);
  const avgConfidence =
    withConfidence.length > 0
      ? withConfidence.reduce((s, r) => s + r.confidence, 0) / withConfidence.length
      : undefined;
  const lowConfidenceCount = withConfidence.filter((r) => r.confidence < 0.5).length;
  printSummaryTable({
    total: processedResults.length,
    classified: processedResults.length - unknownCount,
    unknown: unknownCount,
    overridden: overrideCount,
    duplicatesSkipped,
    apiCalls,
    tokensUsed: totalTokensUsed,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    durationMs: Date.now() - startedAt,
    avgConfidence,
    lowConfidenceCount: lowConfidenceCount > 0 ? lowConfidenceCount : undefined,
    timings:
      config.timing && timings !== undefined
        ? {
            collectionMs: timings.collectionMs,
            exifMs: timings.exifMs,
            dedupMs: timings.dedupMs,
            analysisMs: timings.analysisMs,
            classifyMs: timings.classifyMs,
            processingMs: timings.processingMs,
            cacheWriteMs: tCacheWriteMs,
          }
        : undefined,
  });

  // 9. Exit code 2 on partial failures
  if (partialFailures > 0) {
    logger.warn(`\n ${partialFailures} image(s) could not be analyzed and were marked unknown.`);
    process.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// runReorder
// ---------------------------------------------------------------------------
export async function runReorder(
  config: Config,
  fileRepo: FileRepository = createFileRepository(config),
): Promise<void> {
  const cacheFile = path.join(config.outputDir, CACHE_FILE_NAME);
  if (!(await fileRepo.exists(cacheFile))) {
    throw new Error(`Cannot find cache: ${cacheFile}`);
  }

  const cache = await fileRepo.readJson<AnalysisCache>(cacheFile);
  const images = cache.images;

  if (images.length === 0) {
    logger.warn('No images in cache to reorder');
    return;
  }

  logger.info(`Reordering ${images.length} image(s)...`);

  const timezone = config.categoryConfig.timezone ?? 'UTC';
  const reorderedImages = await reorderImages(config.outputDir, images, timezone);
  const updatedCache: AnalysisCache = { ...cache, images: reorderedImages };

  await fileRepo.writeJsonAtomic(cacheFile, updatedCache);
  logger.success(`Reorder complete. ${images.length} file(s) renamed.`);
}

// ---------------------------------------------------------------------------
// runSingle
// ---------------------------------------------------------------------------
export async function runSingle(
  config: Config,
  number: number,
  filePath: string,
  fileRepo: FileRepository = createFileRepository(config),
): Promise<void> {
  if (!(await fileRepo.exists(filePath))) {
    throw new Error(`File not found: ${filePath}`);
  }

  await fileRepo.ensureDir(config.outputDir);

  const file = path.basename(filePath);
  const { createdAt, exifSource } = await getImageTimestamp(filePath);

  logger.info(`\n Analyzing single image: ${file}`);

  const { images } = await analyzeImages(
    [{ file, fullPath: filePath, createdAt, exifSource }],
    config,
  );
  const analyzed = images[0];

  if (!analyzed) throw new Error('Analysis returned no results');

  const { outputName } = await processImage(analyzed, number, config);

  logger.success(`Done: ${outputName}`);
}

// ---------------------------------------------------------------------------
// runWatch
// ---------------------------------------------------------------------------
export async function runWatch(config: Config): Promise<void> {
  logger.info(`Watch mode: processing existing images in ${config.inputDir}...`);

  // Initial pass — process any already-present unprocessed images
  try {
    await runBatch(config);
  } catch (err) {
    logger.warn(`Initial pass: ${(err as Error).message}`);
  }

  if (process.stdin.isTTY !== false) {
    logger.info(`\n Watching ${config.inputDir} for new images (Ctrl-C to exit).`);
  }

  const watcher: FSWatcher = chokidarWatch(config.inputDir, {
    ignored: /(^|[/\\])\../,
    persistent: true,
    ignoreInitial: true,
    usePolling: config.watchPoll,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let batchRunning = false;

  const flush = async (): Promise<void> => {
    timer = null;
    if (batchRunning) {
      // Batch already in-flight — re-queue after it finishes
      timer = setTimeout(() => {
        void flush();
      }, 2_000);
      return;
    }

    const count = pending.size;
    pending.clear();
    logger.info(`\n Watch: ${count} new image(s) detected, processing...`);

    // Remove idle SIGINT so runBatch's own handler can take over during the batch
    process.off('SIGINT', idleSigint);
    process.off('SIGTERM', idleSigint);
    batchRunning = true;
    try {
      await runBatch(config);
    } catch (err) {
      logger.error(`Watch batch failed: ${(err as Error).message}`);
    } finally {
      batchRunning = false;
      process.on('SIGINT', idleSigint);
      process.on('SIGTERM', idleSigint);
    }

    // More files arrived during the batch run
    if (pending.size > 0) {
      timer = setTimeout(() => {
        void flush();
      }, 2_000);
    }
  };

  const idleSigint = (): void => {
    if (timer) clearTimeout(timer);
    void watcher.close();
    logger.info('\n Watch mode exiting.');
    process.exit(0);
  };

  watcher.on('add', (filePath: string) => {
    if (IMAGE_REGEX.test(filePath)) {
      pending.add(path.basename(filePath));
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void flush();
      }, 2_000);
    }
  });

  // Handle SIGINT/SIGTERM while idle (not during a batch — runBatch handles that itself)
  process.on('SIGINT', idleSigint);
  process.on('SIGTERM', idleSigint);

  // Keep the process alive until SIGINT/SIGTERM exits it
  await new Promise<void>(() => undefined);
}

// ---------------------------------------------------------------------------
// runSuggestCategories
// ---------------------------------------------------------------------------
export async function runSuggestCategories(
  config: Config,
  outputPath: string,
  sampleSize: number,
  fileRepo: FileRepository = createFileRepository(config),
): Promise<void> {
  const client = createLLMClient(config);
  const suggested = await suggestCategories(config.inputDir, sampleSize, client, config);

  const resolved = path.resolve(outputPath);
  await fileRepo.ensureDir(path.dirname(resolved));
  await fileRepo.writeTextAtomic(resolved, JSON.stringify(suggested, null, 2) + '\n');

  logger.success(`\n Suggested taxonomy written to ${outputPath}`);
  logger.info(
    `  ${suggested.categories.length} categories: ${suggested.categories.map((c) => c.name).join(', ')}`,
  );
  logger.info(
    `\n Edit ${outputPath} as needed, then pass it with --categories to start classifying.`,
  );
}

// ---------------------------------------------------------------------------
// runSearch
// ---------------------------------------------------------------------------
export async function runSearch(
  outputDir: string,
  opts: {
    query?: string;
    keyword?: string;
    top: number;
    minScore: number;
    outputFormat: 'pretty' | 'json';
    config: Config;
    fileRepo?: FileRepository;
  },
): Promise<void> {
  const { query, keyword, top, minScore, outputFormat, config } = opts;
  const fileRepo = opts.fileRepo ?? createFileRepository(config);

  if (!query && !keyword) {
    throw new Error('Either --query or --keyword is required.');
  }

  let results: SearchResult[];
  let mode: 'semantic' | 'keyword';

  if (query) {
    results = await searchSemantic(query, outputDir, config, { topK: top, minScore });
    mode = 'semantic';
  } else {
    // Keyword search — load cache first
    const cachePath = path.join(outputDir, 'analysis_results.json');
    if (!(await fileRepo.exists(cachePath))) {
      throw new Error(`analysis_results.json not found in ${outputDir}. Run analysis first.`);
    }
    const cache = await fileRepo.readJson<AnalysisCache>(cachePath);
    results = searchKeyword(keyword as string, cache.images, { topK: top });
    mode = 'keyword';
  }

  if (outputFormat === 'json') {
    process.stdout.write(JSON.stringify({ mode, results }, null, 2) + '\n');
    return;
  }

  // Pretty-print
  if (results.length === 0) {
    logger.info(`No results found (mode: ${mode}).`);
    return;
  }
  logger.info(`\n Search results (${mode}, top ${results.length}):\n`);
  for (const r of results) {
    const score = mode === 'semantic' ? r.score.toFixed(3) : String(r.score);
    logger.info(`  [${r.number}] score=${score} cat=${r.category}`);
    logger.info(`       file: ${r.file}`);
    logger.info(`       ${r.shortDescription}`);
  }
}

// ---------------------------------------------------------------------------
// runDiff
// ---------------------------------------------------------------------------
export async function runDiff(
  beforePath: string,
  afterPath: string,
  outputFormat: 'pretty' | 'json' = 'pretty',
  fileRepo: FileRepository = new NodeFileRepository(),
): Promise<void> {
  if (!(await fileRepo.exists(beforePath))) {
    throw new Error(`File not found: ${beforePath}`);
  }
  if (!(await fileRepo.exists(afterPath))) {
    throw new Error(`File not found: ${afterPath}`);
  }

  const before = await fileRepo.readJson<AnalysisCache>(beforePath);
  const after = await fileRepo.readJson<AnalysisCache>(afterPath);
  const summary = diffCaches(before, after);

  if (outputFormat === 'json') {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  logger.info(`\n Diff: ${beforePath} → ${afterPath}\n`);
  logger.info(
    `  added: ${summary.added}  removed: ${summary.removed}  ` +
      `category changed: ${summary.categoryChanged}  confidence changed: ${summary.confidenceChanged}  ` +
      `unchanged: ${summary.unchanged}`,
  );
  for (const d of summary.diffs) {
    if (d.change === 'unchanged') continue;
    const arrow = d.change === 'added' ? '+' : d.change === 'removed' ? '-' : '~';
    const beforeCat = d.before ? d.before.category : '-';
    const afterCat = d.after ? d.after.category : '-';
    const confStr = d.confidenceDelta !== undefined ? ` Δconf=${d.confidenceDelta.toFixed(2)}` : '';
    logger.info(`  [${arrow}] ${d.file}  ${beforeCat} → ${afterCat}${confStr}`);
  }
}

// ---------------------------------------------------------------------------
// runReport
// ---------------------------------------------------------------------------
export async function runReport(
  outputDir: string,
  outFile: string,
  fileRepo: FileRepository = new NodeFileRepository(),
): Promise<void> {
  const cacheFile = path.join(outputDir, 'analysis_results.json');

  if (!(await fileRepo.exists(cacheFile))) {
    throw new Error(`analysis_results.json not found in ${outputDir}. Run analysis first.`);
  }

  const cache = await fileRepo.readJson<AnalysisCache>(cacheFile);

  logger.info(`Generating HTML report for ${cache.totalImages} images...`);

  const html = await generateHtmlReport(cache, outputDir);

  await fileRepo.ensureDir(path.dirname(outFile));
  await fileRepo.writeTextAtomic(outFile, html);

  logger.success(`Report written to ${outFile}`);
}
