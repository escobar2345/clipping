import type { ClipPlan, KeepSegment } from "./types";

// Pure helpers (no Node APIs) shared by the planner, the server AND the
// Remotion bundle, so everyone agrees on how long an edited clip is and where
// each piece of source video lands on the output timeline.
//
// A clip normally plays source[sourceStartSec .. sourceEndSec] straight
// through. When the clip has `segments` (tightened: silences / filler words cut
// out) only those source ranges play, back to back.

/** The source ranges that actually play, in order. */
export function clipSegments(clip: {
  sourceStartSec: number;
  sourceEndSec: number;
  segments?: KeepSegment[];
}): KeepSegment[] {
  const segs = (clip.segments ?? []).filter(
    (s) => Number.isFinite(s.startSec) && Number.isFinite(s.endSec) && s.endSec > s.startSec
  );
  return segs.length ? segs : [{ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec }];
}

/** Length in seconds of the finished clip (after cuts). */
export function editedDurationSec(clip: Parameters<typeof clipSegments>[0]): number {
  return clipSegments(clip).reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
}

export interface SegmentFrames {
  /** first source frame to play */
  srcFrom: number;
  /** frame on the OUTPUT timeline where this piece starts */
  outFrom: number;
  /** how many frames it lasts */
  frames: number;
}

/** Frame-exact layout of every segment. Rounding is done per segment and summed,
 *  so the composition length and the pieces can never drift apart. */
export function segmentFrames(clip: Parameters<typeof clipSegments>[0], fps: number): SegmentFrames[] {
  let outFrom = 0;
  return clipSegments(clip).map((s) => {
    const frames = Math.max(1, Math.round((s.endSec - s.startSec) * fps));
    const item = { srcFrom: Math.round(s.startSec * fps), outFrom, frames };
    outFrom += frames;
    return item;
  });
}

export function totalFrames(clip: Parameters<typeof clipSegments>[0], fps: number): number {
  const segs = segmentFrames(clip, fps);
  const last = segs[segs.length - 1];
  return last.outFrom + last.frames;
}

/** Maps an absolute source time to the output timeline (seconds from the
 *  start of the finished clip). A time inside a cut lands on the next kept piece. */
export function sourceToEdited(segments: KeepSegment[], absSec: number): number {
  let acc = 0;
  for (const s of segments) {
    if (absSec < s.startSec) return acc;
    if (absSec <= s.endSec) return acc + (absSec - s.startSec);
    acc += s.endSec - s.startSec;
  }
  return acc;
}

/** True when `absSec` falls inside a kept piece. */
export function isKept(segments: KeepSegment[], absSec: number): boolean {
  return segments.some((s) => absSec >= s.startSec && absSec <= s.endSec);
}

/** Inverse of sourceToEdited: which source second is playing at `editedSec`. */
export function editedToSource(segments: KeepSegment[], editedSec: number): number {
  let acc = 0;
  for (const s of segments) {
    const len = s.endSec - s.startSec;
    if (editedSec <= acc + len) return s.startSec + Math.max(0, editedSec - acc);
    acc += len;
  }
  const last = segments[segments.length - 1];
  return last ? last.endSec : 0;
}
