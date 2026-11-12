import { logger } from './logger.js';
import type { AnalysisCache } from '../types.js';

export async function fireWebhook(url: string, cache: AnalysisCache): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cache),
    });
    if (!res.ok) {
      logger.warn(`[webhook] POST ${url} returned ${res.status} ${res.statusText}`);
    } else {
      logger.verbose(`[webhook] POST ${url} → ${res.status}`);
    }
  } catch (err) {
    logger.warn(`[webhook] POST ${url} failed: ${(err as Error).message}`);
  }
}
