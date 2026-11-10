import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AnalysisCache, ProcessedResult } from '../types.js';

/** Escape all HTML special characters to prevent XSS from LLM-generated content. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Read an image file and return it as a base64 data-URI, or null if the file is missing. */
async function toDataUri(filePath: string): Promise<string | null> {
  try {
    const buf = await readFile(filePath);
    return `data:image/jpeg;base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function categoryBadgeColor(category: string): string {
  // Deterministic hue from category name (simple hash → 0-360)
  let h = 0;
  for (let i = 0; i < category.length; i++) {
    h = (h * 31 + category.charCodeAt(i)) % 360;
  }
  return `hsl(${h}, 55%, 38%)`;
}

interface ImageCard {
  readonly result: ProcessedResult;
  readonly thumbUri: string | null;
}

async function buildCards(
  images: readonly ProcessedResult[],
  outputDir: string,
): Promise<ImageCard[]> {
  return Promise.all(
    images.map(async (result) => ({
      result,
      thumbUri: await toDataUri(path.join(outputDir, result.outputFile)),
    })),
  );
}

function renderCard(card: ImageCard): string {
  const { result, thumbUri } = card;
  const color = categoryBadgeColor(result.category);
  const safeDesc = escapeHtml(result.shortDescription);
  const safeCategory = escapeHtml(result.category.replace(/_/g, ' '));
  const safeElements = result.elements
    .map((e) => `<span class="tag">${escapeHtml(e)}</span>`)
    .join('');
  const extractedText = result.extractedText
    ? `<p class="extracted-text">${escapeHtml(result.extractedText)}</p>`
    : '';
  const relatedImages =
    result.relatedImages && result.relatedImages.length > 0
      ? `<p class="related-images">Related: ${result.relatedImages.map((l) => `<a href="#img-${l.number}">#${l.number} <em>${escapeHtml(l.relation.replace(/_/g, ' '))}</em></a>`).join(', ')}</p>`
      : '';
  const thumb = thumbUri
    ? `<img src="${thumbUri}" alt="${escapeHtml(result.outputFile)}" loading="lazy">`
    : `<div class="no-thumb">Image not found</div>`;
  const date = formatDate(result.timestamp);

  return `
    <article class="card" id="img-${result.number}">
      <div class="thumb">${thumb}</div>
      <div class="info">
        <div class="card-header">
          <span class="num">#${result.number}</span>
          <span class="badge" style="background:${color}">${safeCategory}</span>
        </div>
        <p class="desc">${safeDesc}</p>
        <div class="tags">${safeElements}</div>
        ${extractedText}
        ${relatedImages}
        <p class="meta">
          <span>${escapeHtml(result.originalFile)}</span>
          <span>${date}</span>
        </p>
      </div>
    </article>`;
}

function renderCategoryNav(categories: readonly string[]): string {
  const links = categories
    .map((c) => {
      const color = categoryBadgeColor(c);
      return `<a href="#cat-${escapeHtml(c)}" class="nav-badge" style="background:${color}">${escapeHtml(c.replace(/_/g, ' '))}</a>`;
    })
    .join('\n      ');
  return `<nav class="cat-nav">\n      ${links}\n    </nav>`;
}

function renderSection(category: string, cards: ImageCard[]): string {
  const id = `cat-${escapeHtml(category)}`;
  const label = escapeHtml(category.replace(/_/g, ' '));
  const color = categoryBadgeColor(category);
  const cardsHtml = cards.map(renderCard).join('\n');
  return `
  <section id="${id}">
    <h2 class="section-title" style="border-color:${color}">${label} <span class="count">${cards.length}</span></h2>
    <div class="grid">${cardsHtml}
    </div>
  </section>`;
}

function renderCalibrationTable(cache: AnalysisCache): string {
  if (!cache.overrides || cache.overrides.length === 0) return '';

  // Confidence at time of export — keyed by originalFile
  const confidenceByFile = new Map<string, number>(
    cache.images.map((img) => [img.originalFile, img.confidence]),
  );

  // Per-category: total images counted under their final category, overrides counted under original
  const stats = new Map<
    string,
    { count: number; corrected: number; confidenceSum: number; correctedConf: number[] }
  >();

  const ensureEntry = (cat: string) => {
    if (!stats.has(cat))
      stats.set(cat, { count: 0, corrected: 0, confidenceSum: 0, correctedConf: [] });
    return stats.get(cat)!;
  };

  for (const img of cache.images) {
    const s = ensureEntry(img.category);
    s.count++;
    s.confidenceSum += img.confidence;
  }

  for (const override of cache.overrides) {
    const s = ensureEntry(override.originalCategory);
    s.corrected++;
    s.correctedConf.push(confidenceByFile.get(override.file) ?? 0);
  }

  const rows = [...stats.entries()]
    .filter(([, s]) => s.count > 0)
    .sort((a, b) => b[1].corrected - a[1].corrected)
    .map(([cat, s]) => {
      const rate = s.count > 0 ? (s.corrected / s.count) * 100 : 0;
      const avgConf = s.count > 0 ? ((s.confidenceSum / s.count) * 100).toFixed(0) : '—';
      const avgCorrConf =
        s.correctedConf.length > 0
          ? ((s.correctedConf.reduce((a, b) => a + b, 0) / s.correctedConf.length) * 100).toFixed(0)
          : '—';
      const rateColor = rate >= 20 ? '#c0392b' : rate >= 10 ? '#e67e22' : '#27ae60';
      const color = categoryBadgeColor(cat);
      return `<tr>
          <td><span class="badge" style="background:${color}">${escapeHtml(cat.replace(/_/g, ' '))}</span></td>
          <td>${s.count}</td>
          <td>${s.corrected}</td>
          <td style="color:${rateColor};font-weight:600">${rate.toFixed(1)}%</td>
          <td>${avgConf}%</td>
          <td>${avgCorrConf}%</td>
        </tr>`;
    })
    .join('\n        ');

  return `
  <section id="calibration">
    <h2 class="section-title" style="border-color:#888">Confidence Calibration <span class="count">${cache.overrides.length} override${cache.overrides.length === 1 ? '' : 's'}</span></h2>
    <p class="calib-desc">Correction rate shows how often a category's initial classification was manually overridden. High correction rate combined with high average confidence indicates the model is overconfident for that category.</p>
    <div class="table-wrap">
      <table class="calib-table">
        <thead>
          <tr>
            <th>Category</th><th>Images</th><th>Corrected</th><th>Correction Rate</th><th>Avg Confidence</th><th>Avg Conf (corrected)</th>
          </tr>
        </thead>
        <tbody>
        ${rows}
        </tbody>
      </table>
    </div>
  </section>`;
}

/** Generate a self-contained HTML report from the analysis cache. */
export async function generateHtmlReport(cache: AnalysisCache, outputDir: string): Promise<string> {
  const cards = await buildCards(cache.images, outputDir);

  // Group cards by category preserving order
  const byCategory = new Map<string, ImageCard[]>();
  for (const cat of cache.categories) {
    byCategory.set(cat, []);
  }
  for (const card of cards) {
    const bucket = byCategory.get(card.result.category);
    if (bucket) {
      bucket.push(card);
    } else {
      // category not in index (shouldn't happen but be safe)
      const arr: ImageCard[] = [card];
      byCategory.set(card.result.category, arr);
    }
  }

  const sections = [...byCategory.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([cat, items]) => renderSection(cat, items))
    .join('\n');

  const nav = renderCategoryNav(
    [...byCategory.keys()].filter((c) => (byCategory.get(c)?.length ?? 0) > 0),
  );
  const generated = new Date(cache.processedDate).toLocaleString('en-GB');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; script-src 'none';">
<title>Image Analysis Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #222; line-height: 1.5; }
  header { background: #1a1a2e; color: #fff; padding: 1.5rem 2rem; }
  header h1 { font-size: 1.5rem; font-weight: 700; }
  header p { font-size: 0.85rem; opacity: 0.7; margin-top: 0.25rem; }
  .cat-nav { display: flex; flex-wrap: wrap; gap: 0.5rem; padding: 1rem 2rem; background: #fff; border-bottom: 1px solid #e0e0e0; }
  .nav-badge { color: #fff; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.8rem; text-decoration: none; text-transform: capitalize; }
  .nav-badge:hover { opacity: 0.85; }
  main { max-width: 1400px; margin: 0 auto; padding: 1.5rem 2rem; }
  section { margin-bottom: 2.5rem; }
  .section-title { font-size: 1.1rem; font-weight: 600; text-transform: capitalize; border-left: 4px solid; padding-left: 0.75rem; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
  .count { background: #e0e0e0; border-radius: 999px; font-size: 0.8rem; padding: 0.1rem 0.5rem; font-weight: 400; color: #555; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .card { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.1); display: flex; flex-direction: column; }
  .thumb { aspect-ratio: 4/3; overflow: hidden; background: #eee; }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .no-thumb { display: flex; align-items: center; justify-content: center; height: 100%; color: #999; font-size: 0.85rem; }
  .info { padding: 0.75rem; display: flex; flex-direction: column; gap: 0.4rem; flex: 1; }
  .card-header { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
  .num { font-size: 0.75rem; color: #999; }
  .badge { color: #fff; font-size: 0.7rem; padding: 0.15rem 0.5rem; border-radius: 999px; text-transform: capitalize; }
  .desc { font-size: 0.9rem; color: #333; }
  .tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .tag { background: #f0f0f0; color: #555; font-size: 0.72rem; padding: 0.15rem 0.45rem; border-radius: 4px; }
  .extracted-text { font-size: 0.78rem; color: #555; background: #f9f9f9; border-left: 2px solid #ddd; padding: 0.35rem 0.5rem; border-radius: 2px; white-space: pre-wrap; word-break: break-word; max-height: 80px; overflow: hidden; }
  .meta { font-size: 0.72rem; color: #aaa; display: flex; justify-content: space-between; flex-wrap: wrap; gap: 0.25rem; margin-top: auto; padding-top: 0.25rem; border-top: 1px solid #f0f0f0; }
  .calib-desc { font-size: 0.82rem; color: #666; margin-bottom: 1rem; max-width: 700px; }
  .table-wrap { overflow-x: auto; }
  .calib-table { border-collapse: collapse; font-size: 0.85rem; min-width: 560px; }
  .calib-table th { text-align: left; padding: 0.5rem 0.9rem; background: #f5f5f5; border-bottom: 2px solid #ddd; white-space: nowrap; }
  .calib-table td { padding: 0.45rem 0.9rem; border-bottom: 1px solid #eee; }
  .calib-table tr:last-child td { border-bottom: none; }
  footer { text-align: center; padding: 1.5rem; font-size: 0.8rem; color: #aaa; }
</style>
</head>
<body>
<header>
  <h1>Image Analysis Report</h1>
  <p>${cache.totalImages} images &middot; ${cache.categories.length} categories &middot; Generated ${escapeHtml(generated)}</p>
</header>
${nav}
<main>
${sections}
${renderCalibrationTable(cache)}
</main>
<footer>Generated by ai-image-labeling</footer>
</body>
</html>`;
}
