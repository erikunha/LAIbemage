// Pure functions for timestamp overlay — no I/O, fully testable in isolation

const FONT_HEIGHT_RATIO = 0.035;
const TOP_GAP_RATIO = 0.03;
const LARGE_HEIGHT = 5000;
const XL_HEIGHT = 7000;
const LARGE_MULTIPLIER = 1.25;
const XL_MULTIPLIER = 1.4;
const MIN_FONT_SIZE = 56;
const MAX_FONT_SIZE = 320;

export function calculateFontSize(imageHeight: number): number {
  let fontSize = imageHeight * FONT_HEIGHT_RATIO;
  if (imageHeight >= XL_HEIGHT) {
    fontSize *= XL_MULTIPLIER;
  } else if (imageHeight >= LARGE_HEIGHT) {
    fontSize *= LARGE_MULTIPLIER;
  }
  return Math.round(Math.min(Math.max(fontSize, MIN_FONT_SIZE), MAX_FONT_SIZE));
}

export function formatTimestamp(timestampMs: number, timezone: string): string {
  const date = new Date(timestampMs);
  const local = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
  const d = String(local.getDate()).padStart(2, '0');
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const y = local.getFullYear();
  const h = String(local.getHours()).padStart(2, '0');
  const min = String(local.getMinutes()).padStart(2, '0');
  return `${d}/${m}/${y} ${h}:${min}`;
}

export interface TimestampOverlay {
  readonly svg: Buffer;
  readonly overlayWidth: number;
  readonly overlayHeight: number;
}

export function buildTimestampSvg(dateText: string, fontSize: number): TimestampOverlay {
  const dateFontSize = Math.round(fontSize * 0.55);
  const overlayWidth = dateFontSize * 16; // 16 chars: DD/MM/YYYY HH:MM
  const overlayHeight = Math.round(dateFontSize * 1.7);

  const svgMarkup = `<svg width="${overlayWidth}" height="${overlayHeight}">
  <text
    x="50%"
    y="72%"
    text-anchor="middle"
    font-size="${dateFontSize}"
    fill="red"
    font-family="Arial, Helvetica, sans-serif"
    font-weight="bold">${dateText}</text>
</svg>`;

  return { svg: Buffer.from(svgMarkup), overlayWidth, overlayHeight };
}

export function calculateOverlayPosition(
  imageWidth: number,
  imageHeight: number,
  overlayWidth: number,
  overlayHeight: number,
): { left: number; top: number } {
  const bottomGap = Math.round(imageHeight * TOP_GAP_RATIO);
  const left = Math.max(0, Math.round((imageWidth - overlayWidth) / 2));
  const top = Math.round(imageHeight - overlayHeight - bottomGap);
  return { left, top };
}
