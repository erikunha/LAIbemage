import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fireOnImageAnalysed,
  fireOnImageProcessed,
  fireOnRunComplete,
  loadPlugins,
} from '../../src/plugin/index.js';
import type { AnalysisCache, AnalyzedImage, Plugin, ProcessedResult } from '../../src/types.js';
import { CACHE_SCHEMA_VERSION, PLUGIN_API_VERSION } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAnalyzedImage(file = 'a.jpg'): AnalyzedImage {
  return {
    file,
    fullPath: `/input/${file}`,
    createdAt: 1000,
    exifSource: 'ctime',
    analysis: {
      category: 'mold',
      shortDescription: 'A mold image',
      elements: [],
      confidence: 0,
      extractedText: null,
    },
  };
}

function makeProcessedResult(file = 'a.jpg'): ProcessedResult {
  return {
    originalFile: file,
    outputFile: `output/${file}`,
    category: 'mold',
    number: 1,
    shortDescription: 'A mold image',
    elements: [],
    confidence: 0,
    extractedText: null,
    timestamp: 1000,
  };
}

function makeCache(): AnalysisCache {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    processedDate: new Date().toISOString(),
    totalImages: 1,
    categories: ['mold'],
    categoriesHash: 'abc123',
    images: [makeProcessedResult()],
    pluginApiVersion: PLUGIN_API_VERSION,
  };
}

// ---------------------------------------------------------------------------
// loadPlugins
// ---------------------------------------------------------------------------

describe('loadPlugins', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-test-'));
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('returns empty array when no plugin paths provided', async () => {
    const plugins = await loadPlugins([]);
    expect(plugins).toHaveLength(0);
  });

  it('loads a valid plugin that exports a default object with a name', async () => {
    const pluginFile = path.join(tmpDir, 'valid-plugin.mjs');
    await fs.writeFile(pluginFile, `export default { name: 'test-plugin' };`, 'utf8');

    const plugins = await loadPlugins([pluginFile]);
    expect(plugins).toHaveLength(1);
    expect(plugins[0].name).toBe('test-plugin');
  });

  it('skips a file that does not exist and logs a warning', async () => {
    const plugins = await loadPlugins(['/nonexistent/plugin.mjs']);
    expect(plugins).toHaveLength(0);
  });

  it('skips a file whose default export is missing a name string', async () => {
    const pluginFile = path.join(tmpDir, 'no-name-plugin.mjs');
    await fs.writeFile(pluginFile, `export default { };`, 'utf8');

    const plugins = await loadPlugins([pluginFile]);
    expect(plugins).toHaveLength(0);
  });

  it('skips a file whose default export is not an object', async () => {
    const pluginFile = path.join(tmpDir, 'bad-export-plugin.mjs');
    await fs.writeFile(pluginFile, `export default 'not-an-object';`, 'utf8');

    const plugins = await loadPlugins([pluginFile]);
    expect(plugins).toHaveLength(0);
  });

  it('loads multiple plugins in order', async () => {
    const file1 = path.join(tmpDir, 'p1.mjs');
    const file2 = path.join(tmpDir, 'p2.mjs');
    await fs.writeFile(file1, `export default { name: 'first' };`, 'utf8');
    await fs.writeFile(file2, `export default { name: 'second' };`, 'utf8');

    const plugins = await loadPlugins([file1, file2]);
    expect(plugins).toHaveLength(2);
    expect(plugins[0].name).toBe('first');
    expect(plugins[1].name).toBe('second');
  });
});

// ---------------------------------------------------------------------------
// fireOnImageAnalysed
// ---------------------------------------------------------------------------

describe('fireOnImageAnalysed', () => {
  it('calls onImageAnalysed on plugins that implement it', async () => {
    const received: AnalyzedImage[] = [];
    const plugin: Plugin = {
      name: 'spy',
      onImageAnalysed: async (img) => {
        received.push(img);
      },
    };

    const img = makeAnalyzedImage();
    await fireOnImageAnalysed([plugin], img);
    expect(received).toHaveLength(1);
    expect(received[0].file).toBe('a.jpg');
  });

  it('skips plugins without onImageAnalysed', async () => {
    const plugin: Plugin = { name: 'no-hook' };
    // Should not throw
    await expect(fireOnImageAnalysed([plugin], makeAnalyzedImage())).resolves.toBeUndefined();
  });

  it('does not throw when a plugin hook throws — logs warning instead', async () => {
    const plugin: Plugin = {
      name: 'bad-plugin',
      onImageAnalysed: async () => {
        throw new Error('hook failure');
      },
    };
    // Should resolve without throwing
    await expect(fireOnImageAnalysed([plugin], makeAnalyzedImage())).resolves.toBeUndefined();
  });

  it('continues calling remaining plugins after one throws', async () => {
    const called: string[] = [];
    const plugins: Plugin[] = [
      {
        name: 'thrower',
        onImageAnalysed: async () => {
          throw new Error('boom');
        },
      },
      {
        name: 'ok',
        onImageAnalysed: async () => {
          called.push('ok');
        },
      },
    ];
    await fireOnImageAnalysed(plugins, makeAnalyzedImage());
    expect(called).toEqual(['ok']);
  });
});

// ---------------------------------------------------------------------------
// fireOnImageProcessed
// ---------------------------------------------------------------------------

describe('fireOnImageProcessed', () => {
  it('calls onImageProcessed on plugins that implement it', async () => {
    const received: ProcessedResult[] = [];
    const plugin: Plugin = {
      name: 'spy',
      onImageProcessed: async (r) => {
        received.push(r);
      },
    };

    const result = makeProcessedResult();
    await fireOnImageProcessed([plugin], result);
    expect(received).toHaveLength(1);
    expect(received[0].originalFile).toBe('a.jpg');
  });

  it('does not throw when a plugin hook throws', async () => {
    const plugin: Plugin = {
      name: 'bad',
      onImageProcessed: async () => {
        throw new Error('oops');
      },
    };
    await expect(fireOnImageProcessed([plugin], makeProcessedResult())).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fireOnRunComplete
// ---------------------------------------------------------------------------

describe('fireOnRunComplete', () => {
  it('calls onRunComplete with the final cache', async () => {
    const received: AnalysisCache[] = [];
    const plugin: Plugin = {
      name: 'spy',
      onRunComplete: async (cache) => {
        received.push(cache);
      },
    };

    const cache = makeCache();
    await fireOnRunComplete([plugin], cache);
    expect(received).toHaveLength(1);
    expect(received[0].totalImages).toBe(1);
  });

  it('does not throw when a plugin hook throws', async () => {
    const plugin: Plugin = {
      name: 'bad',
      onRunComplete: async () => {
        throw new Error('fail');
      },
    };
    await expect(fireOnRunComplete([plugin], makeCache())).resolves.toBeUndefined();
  });

  it('fires all plugins even if the first throws', async () => {
    const called: string[] = [];
    const plugins: Plugin[] = [
      {
        name: 'thrower',
        onRunComplete: async () => {
          throw new Error('x');
        },
      },
      {
        name: 'ok',
        onRunComplete: async () => {
          called.push('ok');
        },
      },
    ];
    await fireOnRunComplete(plugins, makeCache());
    expect(called).toEqual(['ok']);
  });
});
