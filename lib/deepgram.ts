import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import type { ClipPlan, TranscriptWord } from "./types";
import { retimeClipWithWords, tightenEnabled } from "./tighten";

const execFileAsync = promisify(execFile);

// Deepgram is the speech-to-text engine. Set DEEPGRAM_API_KEY to turn it on.
//
// What it does:
//   1. Whole-video transcript for the AI when the video has NO captions
//      (uploads, local files, sites without subtitles) -> transcribeFullVideo()
//   2. Word-accurate captions burned onto each rendered clip -> refineClipCaptions()
//
// It talks to Deepgram's REST API with a plain fetch (no SDK, no extra npm
// package), so it adds no memory or build weight to the server. Audio is
// extracted with ffmpeg as small 16 kHz mono mp3.
//
//   DEEPGRAM_API_KEY   your key
//   DEEPGRAM_MODEL     default "nova-3"
//   DEEPGRAM_LANGUAGE  optional, e.g. "es". Unset = Deepgram's default (English)
//   DEEPGRAM_MODE      "always"   (default) Deepgram handles all speech-to-text:
//                                 transcript when none exists + every clip's captions
//                      "fallback" only when there is no transcript/captions at all
//                                 (uses the least credit)
//                      "off"      disabled
//   DEEPGRAM_BASE_URL  default https://api.deepgram.com (override for testing)

export function deepgramMode(): "off" | "fallback" | "always" {
  if (!process.env.DEEPGRAM_API_KEY) return "off";
  const m = (process.env.DEEPGRAM_MODE ?? "always").toLowerCase();
  return m === "fallback" || m === "off" ? m : "always";
}

// ~48 kbps mono = ~21 MB/hour. Refuse anything beyond ~4.5 h rather than
// buffering a huge file in memory on a small server.
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;
const CLIP_PAD_SEC = 0.5; // transcribe a little beyond the clip so edge words aren't cut

async function extractAudio(
  videoPath: string,
  outDir: string,
  startSec?: number,
  durSec?: number
): Promise<string> {
  const out = path.join(outDir, "audio.mp3");
  const args: string[] = [];
  if (startSec !== undefined) args.push("-ss", startSec.toFixed(3));
  if (durSec !== undefined) args.push("-t", durSec.toFixed(3));
  args.push("-i", videoPath, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-y", out);
  await execFileAsync("ffmpeg", args, {
    timeout: 20 * 60_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return out;
}

/** Sends one audio file to Deepgram. Returns null on any failure (bad key,
 *  exhausted credit, network...) so callers just keep what they already have. */
async function callDeepgram(audioPath: string, timeoutMs: number): Promise<TranscriptWord[] | null> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return null;

  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL ?? "nova-3",
    smart_format: "true", // punctuation + capitalization (used to split caption cues)
  });
  if (process.env.DEEPGRAM_LANGUAGE) params.set("language", process.env.DEEPGRAM_LANGUAGE);

  const base = (process.env.DEEPGRAM_BASE_URL ?? "https://api.deepgram.com").replace(/\/+$/, "");
  const res = await fetch(`${base}/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "audio/mpeg" },
    body: fs.readFileSync(audioPath),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    // Never log the key. 401 = bad key, 402 = out of credit.
    const body = (await res.text().catch(() => "")).slice(0, 200);
    console.warn(
      `[deepgram] HTTP ${res.status}${
        res.status === 401 || res.status === 402 ? " (check DEEPGRAM_API_KEY / remaining credit)" : ""
      } — speech-to-text skipped. ${body}`
    );
    return null;
  }

  const json: any = await res.json();
  const raw: any[] = json?.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
  const words: TranscriptWord[] = raw
    .map((w) => ({
      // punctuated_word exists when smart_format is on; fall back to plain word
      word: String(w.punctuated_word ?? w.word ?? "").trim(),
      start: Number(w.start),
      end: Number(w.end),
    }))
    .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end));

  // a handful of words is noise (breath, music sting), not speech
  return words.length >= 4 ? words : null;
}

/** Word timings for [startSec, endSec] of the video, relative to startSec. */
export async function transcribeClipWords(
  videoPath: string,
  startSec: number,
  endSec: number
): Promise<TranscriptWord[] | null> {
  if (!process.env.DEEPGRAM_API_KEY) return null;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepgram-"));
  try {
    const audio = await extractAudio(videoPath, tmpDir, startSec, endSec - startSec);
    return await callDeepgram(audio, 60_000);
  } catch (err) {
    console.warn("[deepgram] clip transcription failed:", String(err));
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- whole-video transcript (with an on-disk cache so a retry never pays twice)

function cacheFile(videoPath: string, size: number, mtimeMs: number): string {
  const id = crypto
    .createHash("sha1")
    .update(
      [
        videoPath,
        size,
        Math.round(mtimeMs),
        process.env.DEEPGRAM_MODEL ?? "nova-3",
        process.env.DEEPGRAM_LANGUAGE ?? "",
      ].join("|")
    )
    .digest("hex")
    .slice(0, 24);
  return path.join(process.cwd(), "data", "transcripts", `${id}.json`);
}

/** Word-level transcript of the whole video, in absolute source seconds. */
export async function transcribeFullVideo(videoPath: string): Promise<TranscriptWord[] | null> {
  if (!process.env.DEEPGRAM_API_KEY) return null;
  if (!fs.existsSync(videoPath)) return null;

  const st = fs.statSync(videoPath);
  const cache = cacheFile(videoPath, st.size, st.mtimeMs);
  try {
    const hit = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (Array.isArray(hit?.words) && hit.words.length) return hit.words as TranscriptWord[];
  } catch {
    /* no cache yet */
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deepgram-"));
  try {
    const audio = await extractAudio(videoPath, tmpDir);
    if (fs.statSync(audio).size > MAX_AUDIO_BYTES) {
      console.warn("[deepgram] video is too long to transcribe in one go — skipped");
      return null;
    }
    const words = await callDeepgram(audio, 8 * 60_000);
    if (words) {
      try {
        fs.mkdirSync(path.dirname(cache), { recursive: true });
        fs.writeFileSync(cache, JSON.stringify({ words }));
      } catch {
        /* cache is best-effort (read-only disk etc.) */
      }
    }
    return words;
  } catch (err) {
    console.warn("[deepgram] full-video transcription failed:", String(err));
    return null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Returns the clip with Deepgram-timed captions, or null to keep it as is. */
export async function refineClipCaptions(
  clip: ClipPlan,
  localVideoPath: string
): Promise<ClipPlan | null> {
  const mode = deepgramMode();
  if (mode === "off") return null;
  if (mode === "fallback" && clip.captions?.length) return null;

  const from = Math.max(0, clip.sourceStartSec - CLIP_PAD_SEC);
  const to = clip.sourceEndSec + CLIP_PAD_SEC;
  const rel = await transcribeClipWords(localVideoPath, from, to);
  if (!rel) return null;

  // absolute source seconds; retime cuts silences/fillers, rebuilds the captions
  // on the resulting timeline and moves the zoom keyframes with the video
  const abs = rel.map((w) => ({ ...w, start: w.start + from, end: w.end + from }));
  const retimed = retimeClipWithWords(clip, abs, { tighten: tightenEnabled() });
  return retimed.captions.length ? retimed : null;
}
