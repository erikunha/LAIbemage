import { describe, expect, it } from 'vitest';
import { buildSessions } from '../../src/analyzer/sessions.js';
import type { ProcessedResult } from '../../src/types.js';

function makeResult(number: number, timestampMs: number): ProcessedResult {
  return {
    originalFile: `img${number}.jpg`,
    outputFile: `${number}. img${number}.jpg`,
    category: 'test',
    number,
    shortDescription: 'test image',
    elements: [],
    confidence: 0.9,
    extractedText: null,
    timestamp: timestampMs,
  };
}

const MIN = 60_000;
const BASE = new Date('2024-01-01T10:00:00Z').getTime();

describe('buildSessions', () => {
  it('returns empty when given no images', () => {
    const { sessions, sessionMap } = buildSessions([], 60);
    expect(sessions).toHaveLength(0);
    expect(sessionMap.size).toBe(0);
  });

  it('puts all images in one session when no gap exceeds threshold', () => {
    const images = [
      makeResult(1, BASE),
      makeResult(2, BASE + 10 * MIN),
      makeResult(3, BASE + 20 * MIN),
    ];
    const { sessions, sessionMap } = buildSessions(images, 60);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).toBe(1);
    expect(sessions[0]!.imageNumbers).toEqual([1, 2, 3]);
    expect(sessionMap.get(1)).toBe(1);
    expect(sessionMap.get(2)).toBe(1);
    expect(sessionMap.get(3)).toBe(1);
  });

  it('splits into two sessions when gap exceeds threshold', () => {
    const images = [
      makeResult(1, BASE),
      makeResult(2, BASE + 10 * MIN),
      makeResult(3, BASE + 120 * MIN), // 110-minute gap — exceeds 60 min
      makeResult(4, BASE + 130 * MIN),
    ];
    const { sessions, sessionMap } = buildSessions(images, 60);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.imageNumbers).toEqual([1, 2]);
    expect(sessions[1]!.imageNumbers).toEqual([3, 4]);
    expect(sessionMap.get(1)).toBe(1);
    expect(sessionMap.get(2)).toBe(1);
    expect(sessionMap.get(3)).toBe(2);
    expect(sessionMap.get(4)).toBe(2);
  });

  it('assigns correct startMs and endMs per session', () => {
    const t1 = BASE;
    const t2 = BASE + 5 * MIN;
    const t3 = BASE + 200 * MIN;
    const t4 = BASE + 210 * MIN;
    const images = [makeResult(1, t1), makeResult(2, t2), makeResult(3, t3), makeResult(4, t4)];
    const { sessions } = buildSessions(images, 60);
    expect(sessions[0]!.startMs).toBe(t1);
    expect(sessions[0]!.endMs).toBe(t2);
    expect(sessions[1]!.startMs).toBe(t3);
    expect(sessions[1]!.endMs).toBe(t4);
  });

  it('handles a single image as one session', () => {
    const { sessions, sessionMap } = buildSessions([makeResult(1, BASE)], 60);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.imageNumbers).toEqual([1]);
    expect(sessionMap.get(1)).toBe(1);
  });

  it('sorts images by timestamp regardless of input order', () => {
    const images = [
      makeResult(3, BASE + 200 * MIN),
      makeResult(1, BASE),
      makeResult(2, BASE + 5 * MIN),
    ];
    const { sessions } = buildSessions(images, 60);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.imageNumbers).toEqual([1, 2]);
    expect(sessions[1]!.imageNumbers).toEqual([3]);
  });

  it('creates a new session exactly at the gap boundary', () => {
    const images = [
      makeResult(1, BASE),
      makeResult(2, BASE + 61 * MIN), // exactly 61 minutes — exceeds 60
    ];
    const { sessions } = buildSessions(images, 60);
    expect(sessions).toHaveLength(2);
  });

  it('keeps images in same session when gap equals threshold exactly', () => {
    const images = [
      makeResult(1, BASE),
      makeResult(2, BASE + 60 * MIN), // exactly 60 minutes — NOT greater than threshold
    ];
    const { sessions } = buildSessions(images, 60);
    expect(sessions).toHaveLength(1);
  });
});
