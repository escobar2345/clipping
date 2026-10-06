import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { curlChatOnce } from "./chat";
import { extractFramesAtTimes, getVideoDurationSec } from "./ffmpegFrames";
import { withRetry } from "./retry";
import type { VideoIntel, VisualContext, FrameNote } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Converts a localhost http URL (as stored in intel.videoFilePath by
 * lib/youtube.ts) back into the on-disk path of the cached video. Falls back
 * to returning the input unchanged if it's already a filesystem path.
 */
export function videoUrlToLocalPath(videoFilePath: string): string {
  if (!videoFilePath) return "";
  if (/^https?:\/\//.test(videoFilePath)) {
    try {
      const u = new URL(videoFilePath);
      // /uploads/xxx.mp4 -> <app>/public/uploads/xxx.mp4
      const rel = u.pathname.replace(/^\//, "");
      const local = path.join(process.cwd(), "public", rel);
      if (fs.existsSync(local)) return local;
      return "";
    } catch {
      return "";
    }
  }
  return videoFilePath;
}

/**
 * Layer 1: TRUE frame-by-frame analysis. Runs ffmpeg's scene detector over the
 * entire video and returns the exact timestamps (seconds) where the visual
 * scene changes (hard cuts, angle changes). This is what lets clip boundaries
 * land exactly on real cuts instead of anywhere mid-shot.
 */
export async function detectSceneCuts(
  videoPath: string,
  sensitivity = 0.3,
  timeoutSec = 180
): Promise<number[]> {
  const cuts: number[] = [];
  try {
    // ffmpeg writes the showinfo lines to STDERR; parsing that is reliable.
    const { stderr } = await execFileAsync(
      "ffmpeg",
      [
        "-i", videoPath,
        "-vf", `select='gt(scene,${sensitivity})',showinfo`,
        "-f", "null", "-",
      ],
      { timeout: Math.max(5_000, Math.round(timeoutSec * 1000)), maxBuffer: 16 * 1024 * 1024, windowsHide: true }
    );
    const re = /pts_time:([\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(stderr))) {
      const t = parseFloat(m[1]);
      if (Number.isFinite(t)) cuts.push(t);
    }
  } catch {
    // scene detection is best-effort; callers degrade to no cuts
  }
  // Dedupe cuts closer than 0.4s and drop the very first (time 0).
  const clean: number[] = [];
  for (const t of cuts) {
    if (t < 0.5) continue;
    if (clean.length && t - clean[clean.length - 1] < 0.4) continue;
    clean.push(t);
  }
  return clean;
}
/**
 * Layer 2: semantic vision pass. Picks up to `maxFrames` representative
 * moments (evenly across the timeline PLUS around scene cuts), sends them to
 * the NVIDIA vision model, and collects a structured note per frame: what's
 * happening, on-screen text, and a 0-100 interest score.
 */
export async function describeFramesWithVision(
  videoPath: string,
  durationSec: number,
  sceneCuts: number[],
  maxFrames = 8,
  deadlineMs = 90_000,
  instructions?: string
): Promise<FrameNote[]> {
  const visionModel =
    process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct";
  if (!process.env.NVIDIA_API_KEY) return [];

  // Build sample times: evenly-spaced coverage + a few extra right after cuts.
  const times = new Set<number>();
  const evenStep = durationSec / (maxFrames - 1);
  for (let i = 0; i < maxFrames - 2; i++) {
    times.add(Math.min(Math.max(0.5, evenStep * i), durationSec - 0.5));
  }
  for (const cut of sceneCuts.slice(0, maxFrames)) {
    times.add(Math.min(Math.max(0.5, cut + 0.6), durationSec - 0.5));
  }
  const sorted = [...times].sort((a, b) => a - b).slice(0, maxFrames);

  const frames = await extractFramesAtTimes(videoPath, sorted);
  if (!frames.length) return [];

  // Per-frame vision calls, bounded concurrency. A single 8-frame image call
  // produces a huge generation that this machine's middlebox frequently
  // blackholes; per-frame calls are small (~2s each, proven live) and fail
  // independently, so we keep whatever notes succeed. Scene cuts alone are
  // still the main win; vision notes are a bonus that degrades gracefully.
  const creatorRules = (instructions ?? "").trim().slice(0, 300);
  const SYSTEM = `You analyze video frames. Output ONLY valid JSON in exactly this shape with NO prose: {"events":"short description","onScreenText":"visible text or empty","interest":0} where interest is 0-100 of visual appeal for a short clip (celebration, action, faces, crowd, drama, score = high; static or empty pitch = low). Keep events under 20 words.${creatorRules ? ` The creator's editing rules to weigh when scoring interest: "${creatorRules}".` : ""}`;

  async function describeOne(frame: { atSec: number; dataUri: string }): Promise<FrameNote | null> {
    const payload = JSON.stringify({
      model: visionModel,
      temperature: 0.2,
      max_tokens: 200,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this frame." },
            { type: "image_url", image_url: { url: frame.dataUri } },
          ],
        },
      ],
    });
    const raw = await withRetry(() => curlChatOnce(payload), 2);
    let content = "";
    try {
      const resp = JSON.parse(raw);
      content = resp?.choices?.[0]?.message?.content ?? "";
    } catch {
      return null;
    }
    if (!content.trim()) return null;
    // Model may wrap in prose/markdown — extract the first JSON object.
    let obj: any = null;
    try {
      obj = JSON.parse(content.replace(/```json|```/g, "").trim());
    } catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (m) {
        try {
          obj = JSON.parse(m[0]);
        } catch {
          return null;
        }
      }
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
    return {
      atSec: frame.atSec,
      events: String(obj.events ?? "").slice(0, 300),
      onScreenText: String(obj.onScreenText ?? "").slice(0, 200),
      interest: Math.max(0, Math.min(100, Number(obj.interest) || 0)),
    };
  }

  // Bounded batches of 3 with a hard deadline: per-frame calls each cap at
  // ~150s worst-case, but the whole pass should never drag an edit-plan
  // generation. Whatever notes arrive before the deadline are kept.
  const notes: FrameNote[] = [];
  const DEADLINE_MS = Math.max(1_000, deadlineMs);
  const startedAt = Date.now();
  let cursor = 0;
  while (cursor < frames.length) {
    const remaining = Math.max(0, DEADLINE_MS - (Date.now() - startedAt));
    if (remaining <= 0) break;
    const batch = frames.slice(cursor, cursor + 3);
    cursor += batch.length;
    await Promise.race([
      Promise.all(
        batch.map((frame) =>
          describeOne(frame)
            .then((n) => {
              if (n) notes.push(n);
            })
            .catch(() => {
              /* per-frame best-effort */
            })
        )
      ),
      new Promise<void>((resolve) => setTimeout(resolve, remaining + 1)),
    ]);
  }
  notes.sort((a, b) => a.atSec - b.atSec);
  return notes;
}

/**
 * Full visual-context builder. Resolves the cached mp4, runs the frame-by-frame
 * cut scan and the vision pass, and returns a VisualContext bound to that file.
 * Any failure returns null so the edit-plan generation degrades gracefully.
 */
export async function buildVisualContext(
  intel: VideoIntel,
  budgetMs = 210_000,
  instructions?: string
): Promise<VisualContext | null> {
  const videoPath = videoUrlToLocalPath(intel.videoFilePath);
  if (!videoPath || !fs.existsSync(videoPath)) return null;

  const durationSec =
    intel.durationSec > 0 ? intel.durationSec : await getVideoDurationSec(videoPath);
  if (!durationSec || durationSec < 2) return null;

  // Scene scan + vision share one wall-clock budget so a long video can't
  // blow the route's 300s (maxDuration) cap. Vision gets whatever's left
  // after the scene scan, capped at its own 90s practical ceiling.
  const startedAt = Date.now();
  const sceneTimeoutSec = Math.max(10, Math.floor(budgetMs / 1000 / 2));
  const sceneCuts = await detectSceneCuts(videoPath, 0.3, sceneTimeoutSec);

  const visionBudget = Math.max(
    0,
    Math.min(90_000, budgetMs - (Date.now() - startedAt))
  );

  let frameNotes: FrameNote[] = [];
  try {
    frameNotes = await describeFramesWithVision(
      videoPath,
      durationSec,
      sceneCuts,
      8,
      visionBudget,
      instructions
    );
  } catch {
    // vision pass is best-effort — pure cut analysis still helps
  }

  return { sceneCuts, frameNotes, sourceFile: videoPath };
}

/**
 * Snaps a proposed [start,end] window to the nearest scene cuts within
 * tolerance (in either direction), so boundaries land exactly on real cuts.
 * Returns the input unchanged when no cut is near enough.
 */
export function snapToSceneCuts(
  start: number,
  end: number,
  sceneCuts: number[],
  tolerance = 2.5
): [number, number] {
  if (!sceneCuts.length) return [start, end];
  let s = start;
  let e = end;
  for (const cut of sceneCuts) {
    if (Math.abs(cut - s) <= tolerance) s = cut;
    if (Math.abs(cut - e) <= tolerance) e = cut;
  }
  if (e - s < 2) return [start, end]; // don't collapse the window
  return [s, e];
}
