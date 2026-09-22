import { z } from "zod";
import type {
  CaptionCue,
  ClipPlan,
  EditRules,
  TranscriptWord,
  VideoIntel,
  ZoomKeyframe,
} from "./types";
import { buildCaptionCues } from "./captions";
import { hasExactTimings, retimeClipWithWords, tightenEnabled } from "./tighten";

// Turns the LLM's raw JSON into a plan the renderer can trust:
//  - validates shape (one bad clip never kills the rest)
//  - fixes the time base: the model sees ABSOLUTE transcript times but the
//    renderer reads caption/zoom times RELATIVE to the clip start
//  - snaps clip edges to word boundaries so nobody is cut mid-word
//  - enforces the creator's min/max clip length in code (the prompt alone
//    can't guarantee it)
//  - rebuilds captions from real word timings (verbatim, in sync with audio)

const LEAD_IN_SEC = 0.15; // room before the first spoken word
const TAIL_SEC = 0.3; //     room after the last spoken word
const MAX_TRIM_GAP_SEC = 1.5; // only pull the start forward over gaps this small

const num = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number().finite()
);

const clipCore = z.object({
  clipId: z.union([z.string(), z.number()]).optional(),
  sourceStartSec: num,
  sourceEndSec: num,
  hookTitle: z.string().optional(),
});
const cueSchema = z.object({ text: z.string(), startSec: num, endSec: num });
const kfSchema = z.object({
  atSec: num,
  scale: num,
  focusX: num.optional(),
  focusY: num.optional(),
});

/** Keeps every element that validates, drops the rest. */
function lenient<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T>[] {
  if (!Array.isArray(raw)) return [];
  const out: z.infer<T>[] = [];
  for (const item of raw) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** clipId becomes a file name (`public/renders/<id>.mp4`) and comes from
 *  model output / client JSON — never let it contain path characters. */
export function sanitizeClipId(id: unknown, fallback: string): string {
  const cleaned = String(id ?? "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  return cleaned || fallback;
}

/** The model may echo absolute source times even when relative ones are
 *  expected. Absolute if the values can't fit inside the clip length but do
 *  sit at/after the clip start. */
function looksAbsolute(times: number[], s0: number, e0: number): boolean {
  if (!times.length || s0 <= 1) return false;
  return Math.max(...times) > e0 - s0 + 1 && Math.min(...times) >= s0 - 1;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export interface NormalizeOptions {
  /** Rebuild captions from transcript word timings (default: on). */
  captionsFromTranscript?: boolean;
}

export function normalizeClips(
  rawClips: unknown,
  intel: VideoIntel,
  rules: EditRules,
  opts: NormalizeOptions = {}
): { clips: ClipPlan[]; warnings: string[] } {
  const warnings: string[] = [];
  if (!Array.isArray(rawClips)) {
    return { clips: [], warnings: ["Model returned no clips array."] };
  }

  const words: TranscriptWord[] = [...(intel.transcript ?? [])].sort((a, b) => a.start - b.start);
  const hasWords = words.length > 0;
  const videoDur =
    intel.durationSec > 0 ? intel.durationSec : hasWords ? words[words.length - 1].end : Infinity;
  const minLen = rules.minClipSec > 0 ? rules.minClipSec : 0;
  const maxLen = rules.maxClipSec > 0 ? rules.maxClipSec : Infinity;
  const useTranscriptCaptions =
    (opts.captionsFromTranscript ?? process.env.CAPTIONS_FROM_TRANSCRIPT !== "0") && hasWords;

  // --- word-boundary helpers -------------------------------------------------
  const snapStart = (s: number): number => {
    const i = words.findIndex((w) => w.end > s);
    if (i < 0) return s;
    const w = words[i];
    if (w.start > s + MAX_TRIM_GAP_SEC) return s; // big silent lead-in: leave it
    const prevEnd = i > 0 ? words[i - 1].end : 0;
    // start just before the first word, but never inside the previous word
    return Math.max(w.start - LEAD_IN_SEC, (prevEnd + w.start) / 2, 0);
  };
  const snapEnd = (e: number): number => {
    let j = -1;
    for (let k = words.length - 1; k >= 0; k--) {
      if (words[k].start < e) {
        j = k;
        break;
      }
    }
    if (j < 0) return e;
    const w = words[j];
    const next = words[j + 1];
    let end = w.end + TAIL_SEC;
    if (next) end = Math.min(end, (w.end + next.start) / 2);
    return Math.max(end, w.end);
  };
  const lastWordEndAtOrBefore = (t: number): number | null => {
    for (let k = words.length - 1; k >= 0; k--) if (words[k].end <= t) return words[k].end;
    return null;
  };

  // --- per-clip --------------------------------------------------------------
  const clips: ClipPlan[] = [];
  const usedIds = new Set<string>();

  rawClips.forEach((raw, idx) => {
    const core = clipCore.safeParse(raw);
    if (!core.success) {
      warnings.push(`Clip ${idx + 1} dropped: missing/invalid start or end time.`);
      return;
    }
    const r = raw as Record<string, unknown>;
    const s0 = Math.max(0, core.data.sourceStartSec); // the model's own start
    const e0 = core.data.sourceEndSec;

    let start = s0;
    let end = Math.min(e0, videoDur);
    if (end < start) [start, end] = [end, start];
    if (end - start < 0.5) {
      warnings.push(`Clip ${idx + 1} dropped: shorter than 0.5s.`);
      return;
    }

    if (hasWords) {
      start = snapStart(start);
      end = snapEnd(end);
    }
    end = Math.min(end, videoDur);

    if (end - start > maxLen) {
      const trimmed = lastWordEndAtOrBefore(start + maxLen);
      end = hasWords && trimmed !== null && trimmed - start >= Math.max(minLen, 1)
        ? trimmed
        : start + maxLen;
      warnings.push(`Clip ${idx + 1} trimmed to the ${maxLen}s max length.`);
    }
    if (end - start < minLen) {
      const wanted = Math.min(start + minLen, videoDur);
      end = hasWords ? Math.min(Math.max(snapEnd(wanted), wanted), start + maxLen, videoDur) : wanted;
      if (end - start < minLen - 0.5) {
        warnings.push(`Clip ${idx + 1} is ${(end - start).toFixed(1)}s, under the ${minLen}s minimum.`);
      }
    }
    start = +start.toFixed(3);
    end = +end.toFixed(3);
    const dur = end - start;
    if (dur < 1) {
      warnings.push(`Clip ${idx + 1} dropped: under 1s after trimming.`);
      return;
    }

    // overlapping clips are wasted output
    const clash = clips.find((c) => {
      const ov = Math.min(c.sourceEndSec, end) - Math.max(c.sourceStartSec, start);
      return ov > 0.5 * Math.min(c.sourceEndSec - c.sourceStartSec, dur);
    });
    if (clash) {
      warnings.push(`Clip ${idx + 1} dropped: overlaps ${clash.clipId} by more than half.`);
      return;
    }

    // ids: filesystem-safe and unique
    let clipId = sanitizeClipId(core.data.clipId, `clip-${clips.length + 1}`);
    if (usedIds.has(clipId)) clipId = `clip-${clips.length + 1}`;
    while (usedIds.has(clipId)) clipId += "x";
    usedIds.add(clipId);

    // --- captions ------------------------------------------------------------
    const llmCues = lenient(cueSchema, r.captions);
    const capAbs = looksAbsolute(
      llmCues.flatMap((c) => [c.startSec, c.endSec]),
      s0,
      e0
    );
    const rebase = (t: number, abs: boolean) => (abs ? t : s0 + t) - start;

    let captions: CaptionCue[] = [];
    if (useTranscriptCaptions) captions = buildCaptionCues(words, start, end);
    if (!captions.length) {
      captions = llmCues
        .map((c) => ({
          text: c.text.trim(),
          startSec: clamp(rebase(c.startSec, capAbs), 0, dur),
          endSec: clamp(rebase(c.endSec, capAbs), 0, dur),
        }))
        .filter((c) => c.text && c.endSec > c.startSec)
        .sort((a, b) => a.startSec - b.startSec);
      for (let i = 0; i + 1 < captions.length; i++) {
        captions[i].endSec = Math.min(captions[i].endSec, captions[i + 1].startSec);
      }
      captions = captions.filter((c) => c.endSec > c.startSec);
    }

    // --- zoom keyframes ------------------------------------------------------
    const llmKfs = lenient(kfSchema, r.zoomKeyframes);
    const zoomAbs = looksAbsolute(
      llmKfs.map((k) => k.atSec),
      s0,
      e0
    );
    const byTime = new Map<number, ZoomKeyframe>();
    for (const k of llmKfs) {
      const atSec = +clamp(rebase(k.atSec, zoomAbs), 0, dur).toFixed(3);
      byTime.set(atSec, {
        atSec,
        scale: clamp(k.scale, 1, 1.4),
        focusX: clamp(k.focusX ?? 0.5, 0, 1),
        focusY: clamp(k.focusY ?? 0.5, 0, 1),
      });
    }
    let zoomKeyframes = [...byTime.values()].sort((a, b) => a.atSec - b.atSec);
    if (!zoomKeyframes.length) {
      zoomKeyframes = [
        { atSec: 0, scale: 1.0, focusX: 0.5, focusY: 0.45 },
        { atSec: +(dur * 0.5).toFixed(2), scale: 1.1, focusX: 0.5, focusY: 0.5 },
        { atSec: +dur.toFixed(2), scale: 1.05, focusX: 0.5, focusY: 0.5 },
      ];
    } else {
      // renderer interpolates between neighbours; cover the full clip so the
      // zoom never jumps before the first / after the last keyframe
      if (zoomKeyframes[0].atSec > 0.001) zoomKeyframes.unshift({ ...zoomKeyframes[0], atSec: 0 });
      const last = zoomKeyframes[zoomKeyframes.length - 1];
      if (last.atSec < dur - 0.001) zoomKeyframes.push({ ...last, atSec: +dur.toFixed(3) });
    }

    let plan: ClipPlan = {
      clipId,
      sourceStartSec: start,
      sourceEndSec: end,
      hookTitle: (core.data.hookTitle ?? "").trim().slice(0, 80),
      captions,
      zoomKeyframes,
      minLenSec: minLen > 0 ? minLen : undefined,
    };

    // Tighten: cut dead air + filler words out of the middle of the clip. Only
    // with MEASURED word times (estimated ones would cut in the wrong places)
    // and when captions come from the transcript (they're rebuilt to match).
    // Clips from sources with only estimated times get tightened later, at
    // render time, once Deepgram supplies accurate words.
    if (useTranscriptCaptions && tightenEnabled() && hasExactTimings(words, start, end)) {
      plan = retimeClipWithWords(plan, words, { tighten: true, minLenSec: minLen });
    }
    clips.push(plan);
  });

  return { clips, warnings };
}
