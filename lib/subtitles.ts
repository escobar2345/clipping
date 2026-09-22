import { withRetry } from "./retry";
import type { TranscriptWord } from "./types";

// Subtitle/caption parsing. The streamers~youtube-scraper exposes
// item.subtitles (null when the video has no caption track); other actors use
// transcript/captions keys holding raw SRT/VTT/XML/json3 strings or arrays of
// track objects. extractTranscript() handles every shape we've seen and
// returns [] (never throws) for caption-less videos.

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/** YouTube timedtext XML: <text start="1.5" dur="2.3">words</text> */
function parseTimedTextXml(raw: string) {
  const cues: { start: number; end: number; text: string }[] = [];
  const re = /<text start="([\d.]+)" dur="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = parseFloat(m[1]);
    const dur = parseFloat(m[2]);
    const text = decodeEntities(m[3].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (text) cues.push({ start, end: start + dur, text });
  }
  return cues;
}

/** SRT / WebVTT block format */
function parseSrtVtt(raw: string) {
  const cues: { start: number; end: number; text: string }[] = [];
  const lines = raw.replace(/\r/g, "").split("\n");
  const tsRe =
    /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;
  const toSec = (h: string, m: string, s: string, ms: string) =>
    parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) +
    parseInt(ms.padEnd(3, "0"), 10) / 1000;
  let cur: { start: number; end: number; text: string[] } | null = null;
  for (const line of lines) {
    const m = tsRe.exec(line.trim());
    if (m) {
      if (cur && cur.text.length)
        cues.push({ start: cur.start, end: cur.end, text: cur.text.join(" ").trim() });
      cur = { start: toSec(m[1], m[2], m[3], m[4]), end: toSec(m[5], m[6], m[7], m[8]), text: [] };
      continue;
    }
    // Strip inline markup (<c>, </c>, <00:00:01.000>, <i> ...) — otherwise it
    // leaks into the burned-in captions as literal text.
    const t = decodeEntities(line.replace(/<[^>]+>/g, "")).trim();
    if (cur && t && !/^(WEBVTT|NOTE|Kind:|Language:)/i.test(t) && !/^\d+$/.test(t)) cur.text.push(t);
  }
  if (cur && cur.text.length)
    cues.push({ start: cur.start, end: cur.end, text: cur.text.join(" ").trim() });
  return dedupeRollingCues(cues.filter((c) => c.text));
}

/** YouTube-style "rolling" auto-captions repeat the previous line in the next
 *  cue (and emit ~10ms echo cues). Drop exact repeats and strip the repeated
 *  prefix so every spoken word appears once. */
function dedupeRollingCues(cues: { start: number; end: number; text: string }[]) {
  const out: { start: number; end: number; text: string }[] = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...cue });
      continue;
    }
    if (cue.text === prev.text) {
      prev.end = Math.max(prev.end, cue.end);
      continue;
    }
    if (cue.text.startsWith(prev.text + " ")) {
      out.push({ start: cue.start, end: cue.end, text: cue.text.slice(prev.text.length).trim() });
      continue;
    }
    // "a b c" then "b c d": remove the longest overlap between prev's tail and cue's head
    const pw = prev.text.split(" ");
    const cw = cue.text.split(" ");
    let overlap = 0;
    for (let k = Math.min(pw.length, cw.length); k > 0; k--) {
      if (pw.slice(-k).join(" ") === cw.slice(0, k).join(" ")) {
        overlap = k;
        break;
      }
    }
    const text = cw.slice(overlap).join(" ").trim();
    if (text) out.push({ start: cue.start, end: cue.end, text });
  }
  return out;
}

const INLINE_TS_SPLIT = /<((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3})>/;
const HAS_INLINE_TS = /<(?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3}>/;

function clockToSec(t: string): number {
  const parts = t.replace(",", ".").split(":").map(parseFloat);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}

/**
 * YouTube auto-captions (as written by yt-dlp) carry EXACT per-word start
 * times inline: `word<00:00:01.320><c> next</c>`. Reading them gives true word
 * timing instead of an even spread across the cue. Only the freshly-timed line
 * of each cue is used — the untimed line is the previous caption repeated.
 * Returns [] when the file has no inline timestamps (caller falls back).
 */
function parseWordTimedVtt(raw: string): TranscriptWord[] {
  if (!HAS_INLINE_TS.test(raw)) return [];
  const tsRe =
    /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})/;
  const words: TranscriptWord[] = [];

  for (const block of raw.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const idx = lines.findIndex((l) => l.includes("-->"));
    if (idx < 0) continue;
    const m = tsRe.exec(lines[idx].trim());
    if (!m) continue;
    const cueStart = clockToSec(`${m[1]}:${m[2]}:${m[3]}.${m[4].padEnd(3, "0")}`);
    const cueEnd = clockToSec(`${m[5]}:${m[6]}:${m[7]}.${m[8].padEnd(3, "0")}`);

    for (const line of lines.slice(idx + 1).filter((l) => HAS_INLINE_TS.test(l))) {
      // split() with a capture group alternates: text, ts, text, ts, text ...
      const parts = line.split(INLINE_TS_SPLIT);
      const segs: { start: number; text: string }[] = [];
      for (let i = 0; i < parts.length; i += 2) {
        const start = i === 0 ? cueStart : clockToSec(parts[i - 1]);
        const text = decodeEntities(parts[i].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
        if (text) segs.push({ start, text });
      }
      segs.forEach((seg, i) => {
        const nextStart = i + 1 < segs.length ? segs[i + 1].start : cueEnd;
        // a single word rarely lasts more than ~1s; cueEnd can be much later
        const end = Math.max(Math.min(nextStart, seg.start + 1.0), seg.start + 0.05);
        const toks = seg.text.split(" ").filter(Boolean);
        const step = (end - seg.start) / toks.length;
        toks.forEach((tok, k) =>
          words.push({
            word: tok,
            start: +(seg.start + step * k).toFixed(3),
            end: +(seg.start + step * (k + 1)).toFixed(3),
          })
        );
      });
    }
  }

  words.sort((a, b) => a.start - b.start);
  // drop echo duplicates (same token, same instant)
  return words.filter((w, i) => {
    const p = words[i - 1];
    return !(p && p.word === w.word && Math.abs(p.start - w.start) < 0.05);
  });
}

/** YouTube json3: { events: [{ tStartMs, dDurationMs, segs: [{utf8}] }] } */
function parseJson3(raw: string) {
  const j = JSON.parse(raw);
  return (j.events ?? [])
    .filter((e: any) => e.segs)
    .map((e: any) => ({
      start: (e.tStartMs ?? 0) / 1000,
      end: ((e.tStartMs ?? 0) + (e.dDurationMs ?? 0)) / 1000,
      text: e.segs.map((s: any) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim(),
    }))
    .filter((c: any) => c.text);
}

function parseRaw(raw: string): TranscriptWord[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("<")) return cuesToWords(parseTimedTextXml(trimmed));
  if (trimmed.startsWith("{")) {
    try {
      return cuesToWords(parseJson3(trimmed));
    } catch {
      return [];
    }
  }
  const timed = parseWordTimedVtt(trimmed);
  if (timed.length) return timed;
  return cuesToWords(parseSrtVtt(trimmed));
}

/** Public alias used by lib/anywhere.ts for yt-dlp-written .vtt/.srt files. */
export const parseSubtitleText = parseRaw;

/** Splits phrase-level cues into word-level entries, spreading each cue's
 *  time window evenly across its words (good enough for caption sync). */
function cuesToWords(cues: { start: number; end: number; text: string }[]): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const cue of cues) {
    const parts = cue.text.split(/\s+/).filter(Boolean);
    if (!parts.length) continue;
    const step = Math.max(cue.end - cue.start, 0.05) / parts.length;
    parts.forEach((word, i) => {
      words.push({
        word,
        start: +(cue.start + step * i).toFixed(3),
        end: +(cue.start + step * (i + 1)).toFixed(3),
        estimated: true,
      });
    });
  }
  return words;
}

/** Coaxes a transcript out of whatever the scraper returned. Prefers an
 *  English track when several exist. Never throws — caption-less videos
 *  simply yield []. */
export async function extractTranscript(item: Record<string, any>): Promise<TranscriptWord[]> {
  const rawSubs: any = item.subtitles ?? item.transcript ?? item.captions ?? null;
  if (!rawSubs) return [];

  if (typeof rawSubs === "string") return parseRaw(rawSubs);

  if (Array.isArray(rawSubs)) {
    const enRank = (t: any) =>
      /en/i.test(String(t?.lang ?? t?.language ?? t?.title ?? "")) ? 0 : 1;
    const ordered = [...rawSubs].sort((a, b) => enRank(a) - enRank(b));
    for (const track of ordered) {
      if (typeof track === "string") {
        const words = parseRaw(track);
        if (words.length) return words;
        continue;
      }
      if (track?.data && typeof track.data === "string") {
        const words = parseRaw(track.data);
        if (words.length) return words;
        continue;
      }
      const url: string | undefined = track?.url ?? track?.link ?? track?.src;
      if (!url) continue;
      try {
        const res = await withRetry(() => fetch(url), 2);
        if (!res.ok) continue;
        const words = parseRaw(await res.text());
        if (words.length) return words;
      } catch {
        // try the next track
      }
    }
    return [];
  }

  if (typeof rawSubs === "object") {
    if (typeof rawSubs.data === "string") return parseRaw(rawSubs.data);
    if (typeof rawSubs.url === "string") {
      try {
        const res = await withRetry(() => fetch(rawSubs.url), 2);
        if (res.ok) return parseRaw(await res.text());
      } catch {
        /* fall through */
      }
    }
    // A map like { en: [ {url} ] } — flatten and retry as an array
    const flat = Object.values(rawSubs).flat();
    if (flat.length) return extractTranscript({ subtitles: flat });
  }
  return [];
}