import type { ProcessedResult, Session } from '../types.js';

export interface SessionBuildResult {
  readonly sessions: Session[];
  /** Maps image number → sessionId. */
  readonly sessionMap: Map<number, number>;
}

/**
 * Clusters images into sessions by splitting at timestamp gaps larger than
 * `gapMinutes`. Pure — no I/O, no SDKs.
 */
export function buildSessions(images: ProcessedResult[], gapMinutes: number): SessionBuildResult {
  if (images.length === 0) return { sessions: [], sessionMap: new Map() };

  const sorted = [...images].sort((a, b) => a.timestamp - b.timestamp);
  const gapMs = gapMinutes * 60_000;

  const sessions: Session[] = [];
  const sessionMap = new Map<number, number>();

  let sid = 1;
  let sessionStart = sorted[0]!.timestamp;
  let currentNums: number[] = [];
  let prevTs = sorted[0]!.timestamp;

  for (const img of sorted) {
    if (currentNums.length > 0 && img.timestamp - prevTs > gapMs) {
      sessions.push({
        sessionId: sid,
        startMs: sessionStart,
        endMs: prevTs,
        imageNumbers: [...currentNums],
      });
      for (const n of currentNums) sessionMap.set(n, sid);
      sid++;
      sessionStart = img.timestamp;
      currentNums = [];
    }
    currentNums.push(img.number);
    prevTs = img.timestamp;
  }

  if (currentNums.length > 0) {
    sessions.push({
      sessionId: sid,
      startMs: sessionStart,
      endMs: prevTs,
      imageNumbers: [...currentNums],
    });
    for (const n of currentNums) sessionMap.set(n, sid);
  }

  return { sessions, sessionMap };
}
