/**
 * Plugin loader and hook dispatcher for the lifecycle hooks API.
 *
 * Plugins are loaded once per run via dynamic `import()`. Each hook is wrapped
 * in a try/catch — a failing plugin logs a warning but never aborts the run.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnalysisCache, AnalyzedImage, Plugin, ProcessedResult } from '../types.js';
import { PLUGIN_API_VERSION } from '../types.js';
import { logger } from '../utils/logger.js';

/** Load and validate all plugin files listed in `pluginPaths`. */
export async function loadPlugins(pluginPaths: readonly string[]): Promise<Plugin[]> {
  const plugins: Plugin[] = [];

  for (const rawPath of pluginPaths) {
    const resolved = path.resolve(rawPath);
    const fileUrl = pathToFileURL(resolved).href;

    let mod: { default?: unknown };
    try {
      mod = (await import(fileUrl)) as { default?: unknown };
    } catch (err) {
      logger.warn(`Plugin load failed (${rawPath}): ${String(err)}`);
      continue;
    }

    const plugin = mod.default;
    if (!plugin || typeof plugin !== 'object' || typeof (plugin as Plugin).name !== 'string') {
      logger.warn(
        `Plugin at ${rawPath} must export a default object with a "name" string. Skipping.`,
      );
      continue;
    }

    logger.info(
      `Plugin loaded: ${(plugin as Plugin).name} (pluginApiVersion=${PLUGIN_API_VERSION})`,
    );
    plugins.push(plugin as Plugin);
  }

  return plugins;
}

/** Invoke `onImageAnalysed` on all plugins for a single image. Never throws. */
export async function fireOnImageAnalysed(plugins: Plugin[], result: AnalyzedImage): Promise<void> {
  for (const plugin of plugins) {
    if (typeof plugin.onImageAnalysed === 'function') {
      try {
        await plugin.onImageAnalysed(result);
      } catch (err) {
        logger.warn(`Plugin "${plugin.name}" onImageAnalysed error: ${String(err)}`);
      }
    }
  }
}

/** Invoke `onImageProcessed` on all plugins for a single image. Never throws. */
export async function fireOnImageProcessed(
  plugins: Plugin[],
  result: ProcessedResult,
): Promise<void> {
  for (const plugin of plugins) {
    if (typeof plugin.onImageProcessed === 'function') {
      try {
        await plugin.onImageProcessed(result);
      } catch (err) {
        logger.warn(`Plugin "${plugin.name}" onImageProcessed error: ${String(err)}`);
      }
    }
  }
}

/** Invoke `onRunComplete` on all plugins after the final cache write. Never throws. */
export async function fireOnRunComplete(plugins: Plugin[], cache: AnalysisCache): Promise<void> {
  for (const plugin of plugins) {
    if (typeof plugin.onRunComplete === 'function') {
      try {
        await plugin.onRunComplete(cache);
      } catch (err) {
        logger.warn(`Plugin "${plugin.name}" onRunComplete error: ${String(err)}`);
      }
    }
  }
}
