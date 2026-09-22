import type { ClipPlan, KeepSegment, TranscriptWord, ZoomKeyframe } from "./types";
import { FILLERS, buildCaptionCues } from "./captions";
import { clipSegments, editedDurationSec, editedToSource, sourceToEdited } from "./timeline";

// "Tighten" a clip: cut dead air and filler words out of the middle of it so
// it plays faster and punchier, like a hand-edited short.
//
//  - A pause longer than `maxPauseSec` is shortened to `keepPauseSec`.
//  - Filler words ("um", "uh", ...) are cut out entirely.
//  - A silent gap longer than `maxCutGapSec` is LEFT ALONE: with no speech for
//    that long it is more likely action, a reaction or music than dead air.
//
// Works on real word timings (Deepgram / YouTube word-tagged captions). With
// only estimated timings it would cut in the wrong places, so callers should
// only use it when timings are trustworthy.

export interface TightenOptions {
  maxPauseSec: number;
  keepPauseSec: number;
  maxCutGapSec: number;
  /** a gap that contained a filler is cut down to this much */
  fillerKeepSec: number;
  dropFillers: boolean;
}

export const DEFAULT_TIGHTEN: TightenOptions = {
  maxPauseSec: 0.55,
  keepPauseSec: 0.28,
  maxCutGapSec: 4,
  fillerKeepSec: 0.12,
  dropFillers: true,
};

const isFiller = (w: string) => FILLERS.has(w.toLowerCase().replace(/[^a-z]/g, ""));
const MIN_SEGMENT_SEC = 0.15;

/** Source ranges to keep between [start, end], or [] if nothing worth cutting. */
export function buildKeepSegments(
  words: TranscriptWord[],
  start: number,
  end: number,
  opts: TightenOptions = DEFAULT_TIGHTEN
): KeepSegment[] {
  const inClip = words
    .filter((w) => (w.start + w.end) / 2 >= start && (w.start + w.end) / 2 < end)
    .sort((a, b) => a.start - b.start);
  if (inClip.length < 3) return [];

  // words that stay, and whether a filler sat in the gap before each one
  const kept: { start: number; end: number; fillerBefore: boolean }[] = [];
  let pendingFiller = false;
  for (const w of inClip) {
    if (opts.dropFillers && isFiller(w.word)) {
      pendingFiller = true;
      continue;
    }
    kept.push({ start: Math.max(w.start, start), end: Math.min(w.end, end), fillerBefore: pendingFiller });
    pendingFiller = false;
  }
  if (kept.length < 2) return [];

  const segments: KeepSegment[] = [];
  let segStart = start;
  for (let i = 0; i + 1 < kept.length; i++) {
    const a = kept[i];
    const b = kept[i + 1];
    const gap = b.start - a.end;
    if (gap <= 0) continue;

    let keepGap: number | null = null; // how much of this gap survives; null = untouched
    if (b.fillerBefore && gap <= opts.maxCutGapSec) {
      // the filler goes; what's left is a normal short pause (or a tiny one
      // if the speaker wasn't pausing much around it)
      keepGap = gap > opts.maxPauseSec ? opts.keepPauseSec : opts.fillerKeepSec;
    } else if (gap > opts.maxPauseSec && gap <= opts.maxCutGapSec) {
      keepGap = opts.keepPauseSec;
    }
    if (keepGap === null || keepGap >= gap - 0.05) continue; // nothing meaningful to cut

    // keep half of the surviving pause after word a, half before word b
    const cutFrom = a.end + keepGap / 2;
    const cutTo = b.start - keepGap / 2;
    if (cutTo - cutFrom < 0.05) continue;
    segments.push({ startSec: segStart, endSec: cutFrom });
    segStart = cutTo;
  }
  segments.push({ startSec: segStart, endSec: end });

  // drop slivers left over from adjacent cuts, then round for stable frames
  const merged = segments.filter((s) => s.endSec - s.startSec >= MIN_SEGMENT_SEC);
  if (merged.length <= 1 && merged[0] && Math.abs(merged[0].startSec - start) < 1e-6 && Math.abs(merged[0].endSec - end) < 1e-6) {
    return [];
  }
  return merged.map((s) => ({ startSec: +s.startSec.toFixed(3), endSec: +s.endSec.toFixed(3) }));
}

/**
 * Tightens as much as possible while keeping the finished clip at least
 * `minLenSec` long. Tries the normal setting first, then gentler ones, then
 * gives up (returns []) rather than produce a clip that is too short.
 */
export function tightenWithinMinLength(
  words: TranscriptWord[],
  start: number,
  end: number,
  minLenSec: number
): KeepSegment[] {
  const steps: Partial<TightenOptions>[] = [
    {},
    { maxPauseSec: 0.8, keepPauseSec: 0.45 },
    { maxPauseSec: 1.2, keepPauseSec: 0.7, dropFillers: false },
  ];
  for (const step of steps) {
    const segs = buildKeepSegments(words, start, end, { ...DEFAULT_TIGHTEN, ...step });
    if (!segs.length) return [];
    const len = editedDurationSec({ sourceStartSec: start, sourceEndSec: end, segments: segs });
    if (len >= minLenSec) return segs;
  }
  return [];
}

/** On by default. Set TIGHTEN_CLIPS=0 to keep clips exactly as spoken. */
export function tightenEnabled(): boolean {
  return process.env.TIGHTEN_CLIPS !== "0";
}

/** True when the words inside [start, end] have measured (not estimated) times. */
export function hasExactTimings(words: TranscriptWord[], start: number, end: number): boolean {
  const inClip = words.filter((w) => w.end > start && w.start < end);
  if (inClip.length < 3) return false;
  return inClip.filter((w) => w.estimated).length / inClip.length < 0.2;
}

/**
 * Re-cuts a clip from a set of words: decides the kept segments, rebuilds the
 * captions on the resulting timeline and moves the zoom keyframes along with
 * the video they were aimed at. `words` are absolute source seconds.
 * Falls back to the untightened clip if `tighten` is off or nothing is cut.
 */
export function retimeClipWithWords(
  clip: ClipPlan,
  words: TranscriptWord[],
  opts: { tighten: boolean; minLenSec?: number }
): ClipPlan {
  const oldSegs = clipSegments(clip);
  const newSegs = opts.tighten
    ? tightenWithinMinLength(words, clip.sourceStartSec, clip.sourceEndSec, opts.minLenSec ?? clip.minLenSec ?? 0)
    : [];
  const segments = newSegs.length ? newSegs : undefined;
  const effective = segments ?? [{ startSec: clip.sourceStartSec, endSec: clip.sourceEndSec }];

  const captions = buildCaptionCues(words, clip.sourceStartSec, clip.sourceEndSec, {}, segments);

  const dur = editedDurationSec({ sourceStartSec: clip.sourceStartSec, sourceEndSec: clip.sourceEndSec, segments });
  const byTime = new Map<number, ZoomKeyframe>();
  for (const k of clip.zoomKeyframes) {
    const at = +Math.min(Math.max(sourceToEdited(effective, editedToSource(oldSegs, k.atSec)), 0), dur).toFixed(3);
    byTime.set(at, { ...k, atSec: at });
  }
  const zoomKeyframes = [...byTime.values()].sort((a, b) => a.atSec - b.atSec);
  if (zoomKeyframes.length) {
    if (zoomKeyframes[0].atSec > 0.001) zoomKeyframes.unshift({ ...zoomKeyframes[0], atSec: 0 });
    const last = zoomKeyframes[zoomKeyframes.length - 1];
    if (last.atSec < dur - 0.001) zoomKeyframes.push({ ...last, atSec: +dur.toFixed(3) });
  }

  return {
    ...clip,
    segments,
    captions: captions.length ? captions : clip.captions,
    zoomKeyframes: zoomKeyframes.length ? zoomKeyframes : clip.zoomKeyframes,
  };
}
