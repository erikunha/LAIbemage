import { describe, expect, it } from 'vitest';
import {
  buildTimestampSvg,
  calculateFontSize,
  calculateOverlayPosition,
  formatTimestamp,
} from '../../src/processor/overlay.js';

describe('calculateFontSize', () => {
  it('returns minimum font size for very small images', () => {
    expect(calculateFontSize(100)).toBe(56); // clamped to min
  });

  it('returns maximum font size for very tall images', () => {
    expect(calculateFontSize(100_000)).toBe(320); // clamped to max
  });

  it('applies base ratio for normal images', () => {
    // 3000px * 3.5% = 105px
    const size = calculateFontSize(3000);
    expect(size).toBeGreaterThanOrEqual(100);
    expect(size).toBeLessThanOrEqual(115);
  });

  it('boosts font size for large images (>=5000px)', () => {
    const normal = calculateFontSize(4999);
    const large = calculateFontSize(5000);
    expect(large).toBeGreaterThan(normal);
  });

  it('boosts font size more for XL images (>=7000px)', () => {
    const large = calculateFontSize(5000);
    const xl = calculateFontSize(7000);
    expect(xl).toBeGreaterThan(large);
  });
});

describe('formatTimestamp', () => {
  it('formats timestamp as DD/MM/YYYY HH:MM', () => {
    // 2024-03-15 14:30 UTC
    const ts = new Date('2024-03-15T14:30:00Z').getTime();
    const result = formatTimestamp(ts, 'UTC');
    expect(result).toBe('15/03/2024 14:30');
  });

  it('applies the correct timezone offset', () => {
    // 2024-03-15 00:00 UTC = 2024-03-15 01:00 Europe/Malta (CET +1)
    const ts = new Date('2024-03-15T00:00:00Z').getTime();
    const result = formatTimestamp(ts, 'Europe/Malta');
    expect(result).toBe('15/03/2024 01:00');
  });

  it('zero-pads single digit day/month/hour/minute', () => {
    const ts = new Date('2024-01-05T08:05:00Z').getTime();
    const result = formatTimestamp(ts, 'UTC');
    expect(result).toBe('05/01/2024 08:05');
  });
});

describe('buildTimestampSvg', () => {
  it('returns a Buffer', () => {
    const { svg } = buildTimestampSvg('15/03/2024 14:30', 100);
    expect(svg).toBeInstanceOf(Buffer);
  });

  it('has positive width and height', () => {
    const { overlayWidth, overlayHeight } = buildTimestampSvg('15/03/2024 14:30', 100);
    expect(overlayWidth).toBeGreaterThan(0);
    expect(overlayHeight).toBeGreaterThan(0);
  });

  it('produces valid SVG XML', () => {
    const { svg } = buildTimestampSvg('15/03/2024 14:30', 100);
    const str = svg.toString();
    expect(str).toContain('<svg');
    expect(str).toContain('</svg>');
    expect(str).toContain('15/03/2024 14:30');
  });
});

describe('calculateOverlayPosition', () => {
  it('centers horizontally', () => {
    const { left } = calculateOverlayPosition(1000, 2000, 400, 50);
    expect(left).toBe(300); // (1000 - 400) / 2
  });

  it('places overlay near the bottom with a gap', () => {
    const { top } = calculateOverlayPosition(1000, 2000, 400, 50);
    // bottomGap = 3% of 2000 = 60; top = 2000 - 50 - 60 = 1890
    expect(top).toBe(1890);
  });

  it('clamps left to 0 if overlay is wider than image', () => {
    const { left } = calculateOverlayPosition(100, 2000, 500, 50);
    expect(left).toBe(0);
  });
});
