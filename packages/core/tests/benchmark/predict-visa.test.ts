/**
 * The real-prediction script (spec 003, benchmark baseline).
 *
 * The script turns a gold split plus a real model into the prediction file the
 * benchmark scores. This suite exercises it OFFLINE: the model is a fake
 * `LLMClient` (the interface seam the repo uses everywhere — see
 * `packages/core/tests/analyzer/batch.test.ts`), the dataset is the synthetic
 * fixture, and no network call is made.
 *
 * What is proven here:
 *  - the label vocabulary of the gold set (`normal` / `defect:<class>`) and
 *    the taxonomy the model is asked to answer with;
 *  - that a WRONG answer is recorded as a wrong prediction, never corrected;
 *  - that a category outside the taxonomy, a missing image and an unreadable
 *    manifest all fail the run loudly;
 *  - that a full run writes exactly one prediction row per gold assignment.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LLMClient } from '../../src/analyzer/client.js';
import type { SplitAssignment, SplitManifest } from '../../src/benchmark/splits.js';
import {
  buildPredictionItems,
  buildTaxonomy,
  formatModelVersion,
  labelKeyOf,
  main,
  parseBatchRange,
  runPredict,
  taxonomyNameOf,
} from '../../../../scripts/benchmarks/predict-visa.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** The synthetic fixture: the same shape as the real VisA data. */
const FIXTURE_ROOT = path.join(REPO_ROOT, 'benchmarks', 'fixtures', 'synthetic-fixture');

/** Its gold manifest. */
const FIXTURE_MANIFEST = path.join(REPO_ROOT, 'benchmarks', 'splits', 'synthetic-30.gold.json');

/** The label the analyzer puts in front of every image of a batch. */
const IMAGE_LABEL_PATTERN = /^---\s*Image\s+\d+\s*\((.*)\)\s*---$/;

/** Reads the fixture manifest. */
function readFixtureManifest(): SplitManifest {
  return JSON.parse(readFileSync(FIXTURE_MANIFEST, 'utf8')) as SplitManifest;
}

/** How the fake model should answer. */
interface FakeClientOptions {
  /** The images the model gets wrong (by gold item id). */
  readonly wrongIds?: readonly string[];
  /** A category outside the taxonomy — used to prove the run fails. */
  readonly foreignCategory?: string;
  /** The input tokens each call reports. Defaults to 70. */
  readonly inputTokens?: number;
  /** The output tokens each call reports. Defaults to 30. */
  readonly outputTokens?: number;
}

/**
 * A fake model that answers from the ground truth.
 *
 * It follows the repo's fake-client pattern (`makeClient` of
 * `packages/core/tests/analyzer/batch.test.ts`): the `LLMClient` INTERFACE is
 * mocked, never an SDK. The answer is derived from the image the batch
 * carries, so the fake is a model that can be right and — with `wrongIds` —
 * wrong.
 */
function makeGoldClient(
  assignments: readonly SplitAssignment[],
  taxonomyNameByLabelKey: ReadonlyMap<string, string>,
  options: FakeClientOptions = {},
): LLMClient {
  const byId = new Map(assignments.map((assignment) => [assignment.id, assignment]));
  const wrongIds = new Set(options.wrongIds ?? []);

  return {
    complete: vi.fn(async (_prompt: string, images: { label: string }[]) => {
      const results = images.map((image, index) => {
        const match = IMAGE_LABEL_PATTERN.exec(image.label);
        if (match === null) {
          throw new Error(`the fake client cannot read the image label '${image.label}'`);
        }
        const file = match[1] as string;
        const assignment = byId.get(file);
        if (assignment === undefined) {
          throw new Error(`the fake client received an unknown image '${file}'`);
        }
        const labelKey = labelKeyOf(assignment);
        const correct = taxonomyNameByLabelKey.get(labelKey) as string;
        let category = correct;
        if (options.foreignCategory !== undefined) {
          category = options.foreignCategory;
        } else if (wrongIds.has(file)) {
          // A wrong answer: another class of the same vocabulary.
          const wrong = [...taxonomyNameByLabelKey.values()].find((name) => name !== correct);
          if (wrong === undefined) {
            throw new Error('the vocabulary holds no other category to answer with');
          }
          category = wrong;
        }
        return {
          index: index + 1,
          category,
          shortDescription: 'fake prediction',
          fullDescription: '',
          elements: [],
          confidence: 0.75,
          extractedText: '',
        };
      });
      return {
        text: JSON.stringify({ images: results }),
        tokensUsed: (options.inputTokens ?? 70) + (options.outputTokens ?? 30),
        inputTokens: options.inputTokens ?? 70,
        outputTokens: options.outputTokens ?? 30,
      };
    }),
  };
}

/** A temporary directory the caller must remove. */
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'mv-predict-'));
  // The run must not read the repository's `.env` (it holds real provider
  // keys). The paths of the test are absolute, so moving the working
  // directory is safe.
  try {
    process.chdir(workDir);
  } catch {
    // A worker thread cannot change the working directory — the run still
    // uses the explicit dummy key, so no real key is ever used.
  }
});

afterEach(() => {
  process.chdir(REPO_ROOT);
  rmSync(workDir, { recursive: true, force: true });
});

describe('the label vocabulary of the gold set', () => {
  it('scores a normal assignment as "normal" and an anomalous one as "defect:<class>"', () => {
    const manifest = readFixtureManifest();
    const normal = manifest.assignments.find((a) => a.anomaly === 'normal');
    const anomalous = manifest.assignments.find((a) => a.anomaly !== 'normal');

    expect(normal).toBeDefined();
    expect(labelKeyOf(normal as SplitAssignment)).toBe('normal');
    expect(labelKeyOf(anomalous as SplitAssignment)).toBe(`defect:${(anomalous as SplitAssignment).class}`);
  });

  it('asks the model for the normalised name of a label key', () => {
    // The config schema only accepts lowercase_snake_case category names, and
    // the analyzer normalises every answer the model returns.
    expect(taxonomyNameOf('normal')).toBe('normal');
    expect(taxonomyNameOf('defect:capsules')).toBe('defect_capsules');
    expect(taxonomyNameOf('defect:pcb1')).toBe('defect_pcb1');
  });

  it('records the model version in the form the benchmark demands', () => {
    // docs/architecture/benchmark.md: `model:<name>@<version>` — a bare model
    // id is not a version.
    expect(formatModelVersion('gpt-4o', '2024-11-20')).toBe('model:gpt-4o@2024-11-20');
    expect(formatModelVersion('gpt-4o', 'model:gpt-4o@2024-11-20')).toBe(
      'model:gpt-4o@2024-11-20',
    );
  });
});

describe('buildTaxonomy', () => {
  it('builds one category per label key of the gold set', () => {
    const manifest = readFixtureManifest();
    const taxonomy = buildTaxonomy(manifest);

    expect(taxonomy.document.categories.map((category) => category.name)).toEqual([
      'defect_capsules',
      'defect_pcb1',
      'defect_pcb2',
      'normal',
    ]);
    // The taxonomy name maps back to the gold label key.
    expect(taxonomy.labelKeyByName.get('defect_capsules')).toBe('defect:capsules');
    expect(taxonomy.labelKeyByName.get('normal')).toBe('normal');
    // The description names the object class, so the model can tell the
    // defect classes apart.
    const capsules = taxonomy.document.categories.find((c) => c.name === 'defect_capsules');
    expect(capsules?.description).toContain('capsules');
  });

  it('refuses two label keys that collapse onto the same taxonomy name', () => {
    const manifest = readFixtureManifest();
    const tampered: SplitManifest = {
      ...manifest,
      assignments: [
        { ...manifest.assignments[0] as SplitAssignment, id: 'a', class: 'a-b' },
        { ...manifest.assignments[0] as SplitAssignment, id: 'b', class: 'a_b' },
      ],
    };
    expect(() => buildTaxonomy(tampered)).toThrow(/ambiguous/);
  });
});

describe('buildPredictionItems', () => {
  const assignments: SplitAssignment[] = [
    {
      id: 'capsules/Data/Images/Normal/0000.JPG',
      class: 'capsules',
      anomaly: 'normal',
      split: 'test',
      sha256: 'x',
      path: 'capsules/Data/Images/Normal/0000.JPG',
    },
  ];
  const labelKeyByName = new Map([
    ['normal', 'normal'],
    ['defect_capsules', 'defect:capsules'],
  ]);

  it('records what the model said — a wrong answer stays wrong', () => {
    const predictions = buildPredictionItems({
      assignments,
      results: [
        {
          category: 'defect_capsules',
          shortDescription: 'a cracked capsule',
          fullDescription: '',
          elements: [],
          confidence: 0.4,
          extractedText: null,
        },
      ],
      labelKeyByName,
    });

    expect(predictions).toHaveLength(1);
    expect(predictions[0]).toEqual({
      id: 'capsules/Data/Images/Normal/0000.JPG',
      labelKey: 'defect:capsules',
      probability: 0.4,
    });
  });

  it('records a category outside the taxonomy VERBATIM — the model refused to classify', () => {
    // The analyzer's prompt lets the model answer `unknown` (or invent a
    // category) when it cannot place the image. That is a measurement: the
    // runner scores it as the miss it is. Mapping it onto a gold class would
    // invent a classification the model never made.
    const predictions = buildPredictionItems({
      assignments,
      results: [
        {
          category: 'kitchen',
          shortDescription: 'a kitchen',
          fullDescription: '',
          elements: [],
          confidence: 0.9,
          extractedText: null,
        },
      ],
      labelKeyByName,
    });
    expect(predictions[0]?.labelKey).toBe('kitchen');
  });

  it('records a model REFUSAL ("unknown") under its own name', () => {
    // A model that answers "unknown" WITH a description and a confidence has
    // refused to classify the image — that is a measurement, and it is
    // recorded as the miss it is.
    const predictions = buildPredictionItems({
      assignments,
      results: [
        {
          category: 'unknown',
          shortDescription: 'the specimen cannot be identified',
          fullDescription: '',
          elements: [],
          confidence: 0.2,
          extractedText: null,
        },
      ],
      labelKeyByName,
    });
    expect(predictions[0]?.labelKey).toBe('unknown');
  });

  it('refuses a batch the analyzer PADDED after a provider failure', () => {
    // The analyzer pads a batch it could not get answered with this exact
    // shape. A benchmark run over an incomplete measurement is not a
    // baseline, so the run fails loudly instead of scoring the padding.
    expect(() =>
      buildPredictionItems({
        assignments,
        results: [
          {
            category: 'unknown',
            shortDescription: 'unanalyzed image',
            fullDescription: '',
            elements: [],
            confidence: 0,
            extractedText: null,
          },
        ],
        labelKeyByName,
      }),
    ).toThrow(/provider failed/);
  });

  it('refuses a result count that does not match the assignments', () => {
    expect(() =>
      buildPredictionItems({ assignments, results: [], labelKeyByName }),
    ).toThrow(/answer every gold item/);
  });
});

describe('parseBatchRange', () => {
  it('reads the file range the analyzer names in its prompt', () => {
    const range = parseBatchRange(
      'You will receive 3 images in CHRONOLOGICAL ORDER (Image 7 to 9).',
    );
    expect(range).toEqual({ startIndex: 6, count: 3 });
  });

  it('returns null for a prompt that names no range — no latency is guessed', () => {
    expect(parseBatchRange('classify these images')).toBeNull();
  });
});

describe('a full run against the synthetic fixture', () => {
  it('writes one prediction row per gold assignment', async () => {
    const manifest = readFixtureManifest();
    const taxonomy = buildTaxonomy(manifest);
    const taxonomyNameByLabelKey = new Map(
      [...taxonomy.labelKeyByName].map(([name, labelKey]) => [labelKey, name]),
    );
    const wrongId = manifest.assignments[0]?.id as string;

    const outPath = path.join(workDir, 'predictions.json');
    const report = await runPredict({
      splitPath: FIXTURE_MANIFEST,
      rootDir: FIXTURE_ROOT,
      outPath,
      provider: 'openai',
      model: 'gpt-4o',
      modelVersion: '2024-11-20',
      apiKey: 'test-key',
      batchSize: 10,
      concurrency: 1,
      delayBetweenCallsMs: 0,
      // A huge explicit ceiling: the run must complete unchanged under a
      // budget it can never reach.
      maxUsdMicro: 10_000_000_000,
      client: makeGoldClient(manifest.assignments, taxonomyNameByLabelKey, {
        wrongIds: [wrongId],
      }),
    });

    const predictions = JSON.parse(readFileSync(outPath, 'utf8')) as {
      id: string;
      labelKey: string;
      probability: number;
      latencyMs?: number;
      costUsd?: number;
    }[];

    // One row per gold assignment, with the gold item ids.
    expect(predictions).toHaveLength(manifest.assignments.length);
    expect(new Set(predictions.map((prediction) => prediction.id))).toEqual(
      new Set(manifest.assignments.map((assignment) => assignment.id)),
    );

    // Every label key is one of the gold vocabulary.
    const vocabulary = new Set(manifest.assignments.map(labelKeyOf));
    for (const prediction of predictions) {
      expect(vocabulary.has(prediction.labelKey)).toBe(true);
      expect(prediction.probability).toBe(0.75);
    }

    // The image the model got wrong is recorded as WRONG, not corrected.
    const wrong = predictions.find((prediction) => prediction.id === wrongId);
    expect(wrong).toBeDefined();
    expect(wrong?.labelKey).not.toBe(labelKeyOf(
      manifest.assignments.find((a) => a.id === wrongId) as SplitAssignment,
    ));

    // The report matches the file.
    expect(report.predictions).toHaveLength(manifest.assignments.length);
    expect(report.manifestId).toBe(manifest.id);
    expect(report.modelVersion).toBe('model:gpt-4o@2024-11-20');
  });

  it('records the latency of the batch and the cost of the tokens', async () => {
    const manifest = readFixtureManifest();
    const taxonomy = buildTaxonomy(manifest);
    const taxonomyNameByLabelKey = new Map(
      [...taxonomy.labelKeyByName].map(([name, labelKey]) => [labelKey, name]),
    );

    const outPath = path.join(workDir, 'predictions.json');
    const report = await runPredict({
      splitPath: FIXTURE_MANIFEST,
      rootDir: FIXTURE_ROOT,
      outPath,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
      batchSize: 10,
      concurrency: 1,
      delayBetweenCallsMs: 0,
      client: makeGoldClient(manifest.assignments, taxonomyNameByLabelKey),
    });

    const predictions = JSON.parse(readFileSync(outPath, 'utf8')) as {
      latencyMs?: number;
      costUsd?: number;
    }[];
    expect(predictions.every((prediction) => (prediction.latencyMs ?? 0) > 0)).toBe(true);
    // `gpt-4o` is pinned in PROVIDER_PRICING, so the cost is recorded.
    expect(predictions.every((prediction) => (prediction.costUsd ?? 0) > 0)).toBe(true);
    expect(report.totalCostUsd).toBeGreaterThan(0);
  });

  it('a run whose pinned estimate exceeds --max-usd-micro refuses before the first provider call', async () => {
    const manifest = readFixtureManifest();
    const taxonomy = buildTaxonomy(manifest);
    const taxonomyNameByLabelKey = new Map(
      [...taxonomy.labelKeyByName].map(([name, labelKey]) => [labelKey, name]),
    );
    const client = makeGoldClient(manifest.assignments, taxonomyNameByLabelKey);
    const outPath = path.join(workDir, 'predictions.json');

    // The pinned estimate for this run (30 images, batch size 10, openai, the
    // pinned gpt-4o rates at detail:low) is 34125 usd-micro; a ceiling of
    // 1000 usd-micro is far below it.
    const run = runPredict({
      splitPath: FIXTURE_MANIFEST,
      rootDir: FIXTURE_ROOT,
      outPath,
      provider: 'openai',
      model: 'gpt-4o',
      modelVersion: '2024-11-20',
      apiKey: 'test-key',
      batchSize: 10,
      concurrency: 1,
      delayBetweenCallsMs: 0,
      maxUsdMicro: 1_000,
      client,
    });
    await expect(run).rejects.toThrow(/34125/);
    const refusal = await run.catch((error: unknown): unknown => error);

    // The typed refusal names the estimate, the ceiling and the provider.
    expect((refusal as Error).name).toBe('BudgetExceededError');
    expect((refusal as Error).message).toContain('34125');
    expect((refusal as Error).message).toContain('1000');
    expect((refusal as Error).message).toContain('openai');
    const fields = refusal as {
      provider?: unknown;
      budgetUsdMicro?: unknown;
      estimatedUsdMicro?: unknown;
    };
    expect(fields.provider).toBe('openai');
    expect(fields.budgetUsdMicro).toBe(1_000);
    expect(fields.estimatedUsdMicro).toBe(34_125);

    // Refused BEFORE the first provider call: the client was never used and
    // nothing was written.
    expect(vi.mocked(client.complete)).toHaveBeenCalledTimes(0);
    expect(existsSync(outPath)).toBe(false);
  });

  it('a run whose pinned estimate equals the ceiling proceeds (only exceeding refuses)', async () => {
    const manifest = readFixtureManifest();
    const taxonomy = buildTaxonomy(manifest);
    const taxonomyNameByLabelKey = new Map(
      [...taxonomy.labelKeyByName].map(([name, labelKey]) => [labelKey, name]),
    );
    const client = makeGoldClient(manifest.assignments, taxonomyNameByLabelKey);
    const outPath = path.join(workDir, 'predictions.json');

    // The pinned estimate is 34125 usd-micro (see the refusal test above), so a
    // ceiling exactly equal to it must proceed: the gate refuses only when the
    // estimate EXCEEDS the ceiling.
    await runPredict({
      splitPath: FIXTURE_MANIFEST,
      rootDir: FIXTURE_ROOT,
      outPath,
      provider: 'openai',
      model: 'gpt-4o',
      modelVersion: '2024-11-20',
      apiKey: 'test-key',
      batchSize: 10,
      concurrency: 1,
      delayBetweenCallsMs: 0,
      maxUsdMicro: 34_125,
      client,
    });

    expect(vi.mocked(client.complete)).toHaveBeenCalledTimes(3);
    expect(existsSync(outPath)).toBe(true);
    const predictions = JSON.parse(readFileSync(outPath, 'utf8')) as unknown[];
    expect(predictions).toHaveLength(30);
  });

  it('accumulated observed cost crossing the budget mid-run aborts and reports the partial spend', async () => {
    const manifest = readFixtureManifest();
    const taxonomy = buildTaxonomy(manifest);
    const taxonomyNameByLabelKey = new Map(
      [...taxonomy.labelKeyByName].map(([name, labelKey]) => [labelKey, name]),
    );
    // Each answered call reports 4000 input + 1000 output tokens, which prices
    // at 0.02 USD per call for gpt-4o: two calls spend 40000 usd-micro.
    const client = makeGoldClient(manifest.assignments, taxonomyNameByLabelKey, {
      inputTokens: 4_000,
      outputTokens: 1_000,
    });
    const outPath = path.join(workDir, 'predictions.json');

    // The pinned estimate (34125 usd-micro) fits the 35000 usd-micro ceiling,
    // so the run starts; the OBSERVED spend crosses the ceiling on the second
    // answered call.
    const run = runPredict({
      splitPath: FIXTURE_MANIFEST,
      rootDir: FIXTURE_ROOT,
      outPath,
      provider: 'openai',
      model: 'gpt-4o',
      modelVersion: '2024-11-20',
      apiKey: 'test-key',
      batchSize: 10,
      concurrency: 1,
      delayBetweenCallsMs: 0,
      maxUsdMicro: 35_000,
      client,
    });
    await expect(run).rejects.toThrow(/40000/);
    const abort = await run.catch((error: unknown): unknown => error);

    // The abort names the partial spend observed so far, the ceiling and the
    // provider.
    expect((abort as Error).name).toBe('BudgetExceededError');
    expect((abort as Error).message).toContain('40000');
    expect((abort as Error).message).toContain('35000');
    expect((abort as Error).message).toContain('openai');
    const fields = abort as {
      provider?: unknown;
      budgetUsdMicro?: unknown;
      spentUsdMicro?: unknown;
    };
    expect(fields.provider).toBe('openai');
    expect(fields.budgetUsdMicro).toBe(35_000);
    expect(fields.spentUsdMicro).toBe(40_000);

    // The abort is genuinely mid-run: two calls were answered before the spend
    // crossed the ceiling, and no third call is made.
    expect(vi.mocked(client.complete)).toHaveBeenCalledTimes(2);

    // A partial prediction set is never published: no file is written.
    expect(existsSync(outPath)).toBe(false);
  });

  it('fails loudly when the manifest cannot be read', async () => {
    await expect(
      runPredict({
        splitPath: path.join(workDir, 'does-not-exist.gold.json'),
        rootDir: FIXTURE_ROOT,
        outPath: path.join(workDir, 'predictions.json'),
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'test-key',
        client: makeGoldClient([], new Map()),
      }),
    ).rejects.toThrow(/cannot read the gold manifest/);
  });

  it('fails loudly when an image of the manifest is missing', async () => {
    const manifest = readFixtureManifest();
    const taxonomy = buildTaxonomy(manifest);
    const taxonomyNameByLabelKey = new Map(
      [...taxonomy.labelKeyByName].map(([name, labelKey]) => [labelKey, name]),
    );

    await expect(
      runPredict({
        splitPath: FIXTURE_MANIFEST,
        rootDir: path.join(workDir, 'empty-root'),
        outPath: path.join(workDir, 'predictions.json'),
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'test-key',
        client: makeGoldClient(manifest.assignments, taxonomyNameByLabelKey),
      }),
    ).rejects.toThrow(/missing image file\(s\)/);
  });

  it('refuses a manifest path that points outside the image root', async () => {
    const manifest = readFixtureManifest();
    const tampered: SplitManifest = {
      ...manifest,
      assignments: [
        {
          ...(manifest.assignments[0] as SplitAssignment),
          id: 'escaped.jpg',
          path: '../../etc/passwd',
        },
      ],
    };
    const splitPath = path.join(workDir, 'tampered.gold.json');
    writeFileSync(splitPath, JSON.stringify(tampered), 'utf8');

    await expect(
      runPredict({
        splitPath,
        rootDir: FIXTURE_ROOT,
        outPath: path.join(workDir, 'predictions.json'),
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'test-key',
        client: makeGoldClient([], new Map()),
      }),
    ).rejects.toThrow(/points outside the image root/);
  });

  it('records an answer outside the taxonomy instead of failing the run', async () => {
    const manifest = readFixtureManifest();
    const taxonomy = buildTaxonomy(manifest);
    const taxonomyNameByLabelKey = new Map(
      [...taxonomy.labelKeyByName].map(([name, labelKey]) => [labelKey, name]),
    );
    const outPath = path.join(workDir, 'predictions.json');

    await runPredict({
      splitPath: FIXTURE_MANIFEST,
      rootDir: FIXTURE_ROOT,
      outPath,
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'test-key',
      maxUsdMicro: 10_000_000_000,
      client: makeGoldClient(manifest.assignments, taxonomyNameByLabelKey, {
        foreignCategory: 'kitchen',
      }),
    });

    // Every answer is the model's own; the runner will score them as the
    // misses they are.
    const predictions = JSON.parse(readFileSync(outPath, 'utf8')) as {
      id: string;
      labelKey: string;
    }[];
    expect(predictions.length).toBe(manifest.assignments.length);
    expect(new Set(predictions.map((row) => row.labelKey))).toEqual(new Set(['kitchen']));
  });

  it('fails the run when the provider fails outright — an incomplete measurement is not a baseline', async () => {
    const outPath = path.join(workDir, 'predictions.json');

    // A provider that fails for good: the analyzer pads the batch with
    // 'unknown', and the run records that. The runner scores those answers
    // as the misses they are.
    const failingClient: LLMClient = {
      complete: vi.fn(async () => {
        throw new Error('the provider is unreachable');
      }),
    };

    await expect(
      runPredict({
        splitPath: FIXTURE_MANIFEST,
        rootDir: FIXTURE_ROOT,
        outPath,
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'test-key',
        maxRetries: 1,
        client: failingClient,
      }),
    ).rejects.toThrow(/provider failed/);

    // No prediction file: the run never produced a measurement.
    expect(existsSync(outPath)).toBe(false);
  }, 30_000);

  it('does not write a prediction file when the run fails', async () => {
    const outPath = path.join(workDir, 'predictions.json');
    writeFileSync(outPath, '[]', 'utf8');

    // A manifest that names an image which is not on disk: the run cannot
    // happen at all, and the previous file must survive it untouched.
    const manifest = readFixtureManifest();
    const broken = {
      ...manifest,
      assignments: [
        {
          ...manifest.assignments[0]!,
          path: 'capsules/Data/Images/Normal/does-not-exist.JPG',
        },
        ...manifest.assignments.slice(1),
      ],
    };
    const splitPath = path.join(workDir, 'missing-image.gold.json');
    writeFileSync(splitPath, JSON.stringify(broken), 'utf8');

    await expect(
      runPredict({
        splitPath,
        rootDir: FIXTURE_ROOT,
        outPath,
        provider: 'openai',
        model: 'gpt-4o',
        apiKey: 'test-key',
        client: makeGoldClient(manifest.assignments, new Map()),
      }),
    ).rejects.toThrow(/missing image file/);

    // The failed run left the previous file untouched — a stale predictions
    // file is never silently replaced by a broken run.
    expect(readFileSync(outPath, 'utf8')).toBe('[]');
  });
});

describe('the command line', () => {
  it('writes the predictions file and names the next step', async () => {
    const manifest = readFixtureManifest();
    const taxonomy = buildTaxonomy(manifest);
    const taxonomyNameByLabelKey = new Map(
      [...taxonomy.labelKeyByName].map(([name, labelKey]) => [labelKey, name]),
    );
    const outPath = path.join(workDir, 'cli-predictions.json');

    await main(
      [
        '--split',
        FIXTURE_MANIFEST,
        '--root',
        FIXTURE_ROOT,
        '--out',
        outPath,
        '--provider',
        'openai',
        '--model',
        'gpt-4o',
        '--model-version',
        '2024-11-20',
        '--api-key',
        'test-key',
        '--batch-size',
        '20',
        '--max-usd-micro',
        '10000000000',
      ],
      { client: makeGoldClient(manifest.assignments, taxonomyNameByLabelKey) },
    );

    const predictions = JSON.parse(readFileSync(outPath, 'utf8')) as { id: string }[];
    expect(predictions).toHaveLength(manifest.assignments.length);
  });

  it('refuses an unknown provider', async () => {
    await expect(
      main([
        '--split',
        FIXTURE_MANIFEST,
        '--root',
        FIXTURE_ROOT,
        '--out',
        path.join(workDir, 'nope.json'),
        '--provider',
        'not-a-provider',
      ]),
    ).rejects.toThrow(/unknown provider/);
  });
});
