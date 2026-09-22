import type { CaptionCue, CaptionWord, KeepSegment, TranscriptWord } from "./types";
import { editedDurationSec, sourceToEdited } from "./timeline";

// Builds burned-in caption cues from REAL word timings instead of asking the
// LLM to invent them. The model only decides *which* moment to clip; every
// caption is a verbatim slice of the transcript, so text and audio always
// agree and timing can't drift.

export interface CaptionOptions {
  /** Max words shown at once (short-form sweet spot is 3-4). */
  maxWordsPerCue?: number;
  /** Hard cap on how long one cue stays up. */
  maxCueSec?: number;
  /** A pause longer than this always starts a new cue. */
  gapBreakSec?: number;
  /** Remove "um", "uh", ... (the audio keeps them, the captions don't). */
  dropFillers?: boolean;
}

export const FILLERS = new Set(["um", "umm", "uh", "uhh", "uhm", "er", "erm"]);
const SENTENCE_END = /[.!?…]["')\]]?$/;
const CLAUSE_END = /[,;:—–-]["')\]]?$/;

/** Removes non-speech annotations like [Music], (applause), ♪ ... and
 *  speaker-change markers. Bracketed spans can cover several tokens, so this
 *  is stateful across the whole word list. */
function cleanTokens(words: TranscriptWord[], dropFillers: boolean): TranscriptWord[] {
  const out: TranscriptWord[] = [];
  let closer: string | null = null;
  for (const w of words) {
    let t = (w.word ?? "").trim();
    if (!t) continue;

    if (closer) {
      if (t.includes(closer)) closer = null;
      continue;
    }
    if (t.startsWith("[") || t.startsWith("(")) {
      const want = t.startsWith("[") ? "]" : ")";
      if (!t.includes(want)) closer = want;
      continue;
    }

    t = t.replace(/^>+/, "").replace(/[♪♫]+/g, "").trim();
    if (!t) continue;

    const bare = t.toLowerCase().replace(/[^a-z]/g, "");
    if (dropFillers && FILLERS.has(bare)) continue;

    out.push({ word: t, start: w.start, end: w.end });
  }
  return out;
}

/**
 * @param words     transcript words in ABSOLUTE source-video seconds
 * @param clipStart clip.sourceStartSec
 * @param clipEnd   clip.sourceEndSec
 * @param segments  optional: the source ranges kept in a TIGHTENED clip. Words
 *                  in the cut parts are dropped and the rest are placed on the
 *                  edited timeline.
 * @returns cues whose times are RELATIVE to the clip start (edited timeline)
 */
export function buildCaptionCues(
  words: TranscriptWord[],
  clipStart: number,
  clipEnd: number,
  opts: CaptionOptions = {},
  segments?: KeepSegment[]
): CaptionCue[] {
  const maxWords = opts.maxWordsPerCue ?? 4;
  const maxCueSec = opts.maxCueSec ?? 2.4;
  const gapBreak = opts.gapBreakSec ?? 0.6;
  const segs = segments && segments.length ? segments : null;
  const dur = segs
    ? editedDurationSec({ sourceStartSec: clipStart, sourceEndSec: clipEnd, segments: segs })
    : Math.max(0, clipEnd - clipStart);
  if (dur <= 0) return [];

  const inClip = cleanTokens(
    words.filter((w) => w.end > clipStart && w.start < clipEnd),
    opts.dropFillers ?? true
  );

  // absolute -> clip-relative (edited timeline), clamped to the clip window
  const rel: CaptionWord[] = [];
  for (const w of inClip) {
    let startSec: number;
    let endSec: number;
    if (segs) {
      const mid = (w.start + w.end) / 2;
      const seg = segs.find((g) => mid >= g.startSec && mid <= g.endSec);
      if (!seg) continue; // this word was cut out of the tightened clip
      startSec = sourceToEdited(segs, Math.max(w.start, seg.startSec));
      endSec = sourceToEdited(segs, Math.min(w.end, seg.endSec));
    } else {
      startSec = Math.max(0, w.start - clipStart);
      endSec = w.end - clipStart;
    }
    endSec = Math.min(dur, Math.max(endSec, startSec + 0.08));
    if (startSec >= dur) continue;
    rel.push({ text: w.word, startSec: +startSec.toFixed(3), endSec: +endSec.toFixed(3) });
  }
  if (!rel.length) return [];

  // group into cues
  const groups: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  for (const w of rel) {
    const prev = cur[cur.length - 1];
    if (prev) {
      const gap = w.startSec - prev.endSec;
      const cueSpan = w.endSec - cur[0].startSec;
      const shouldBreak =
        cur.length >= maxWords ||
        gap > gapBreak ||
        cueSpan > maxCueSec ||
        SENTENCE_END.test(prev.text) ||
        (CLAUSE_END.test(prev.text) && cur.length >= 3);
      if (shouldBreak) {
        groups.push(cur);
        cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);

  // cues: hold each one a touch longer (readability) but never into the next
  const cues: CaptionCue[] = groups.map((g) => ({
    text: g
      .map((w) => w.text)
      .join(" ")
      .replace(/[.,;:!?…]+$/, ""), // house style: no trailing punctuation
    startSec: g[0].startSec,
    endSec: g[g.length - 1].endSec,
    words: g.map((w) => ({ ...w, text: w.text.replace(/[.,;:!?…]+$/, "") })),
  }));

  for (let i = 0; i < cues.length; i++) {
    const nextStart = i + 1 < cues.length ? cues[i + 1].startSec : dur;
    const wantEnd = Math.max(cues[i].endSec + 0.25, cues[i].startSec + 0.4);
    cues[i].endSec = +Math.min(wantEnd, nextStart, dur).toFixed(3);
    if (cues[i].endSec <= cues[i].startSec) cues[i].endSec = +(cues[i].startSec + 0.05).toFixed(3);
  }
  return cues;
}
