import OpenAI from "openai";
import type {
  VideoIntel,
  StyleProfile,
  EditRules,
  EditPlan,
  ClipPlan,
  CaptionCue,
  VisualContext,
} from "./types";
import { extractFramesAsDataUris } from "./ffmpegFrames";
import { snapToSceneCuts, detectSceneCuts } from "./visualScan";
import { withRetry } from "./retry";
import { DEFAULT_EDIT_SYSTEM_PROMPT } from "./prompts";

// build.nvidia.com exposes GLM (and many other) models behind an
// OpenAI-compatible /v1/chat/completions endpoint, so the official `openai`
// SDK works as-is â€” just point baseURL at NVIDIA and use your NVIDIA key.
//
// The client is created LAZILY (on first call) instead of at module scope:
// eagerly constructing OpenAI with an empty key throws, which used to crash
// `next build` during page-data collection on machines where .env.local isn't
// set up yet.
let _client: OpenAI | null = null;
function glmClient(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY,
      baseURL: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      // Edit plans on long transcripts can legitimately take a while, but
      // never hang forever (SDK default is 10 minutes).
      timeout: 180_000,
      maxRetries: 0,
    });
  }
  return _client;
}

// The default system prompt lives in lib/prompts.ts (DEFAULT_EDIT_SYSTEM_PROMPT)
// and can be overridden per-run â€” generateEditPlan takes an optional
// systemPrompt argument that the UI (and the /api/edit-plan route) supplies.

export async function generateEditPlan(
  intel: VideoIntel,
  rules: EditRules,
  styleProfile?: StyleProfile,
  systemPrompt?: string,
  visualContext?: VisualContext | null,
  targetPlatforms?: string[]
): Promise<EditPlan> {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error(
      "NVIDIA_API_KEY is not set in your environment â€” get a key at build.nvidia.com"
    );
  }

  // No transcript? (music-only compilations etc. â€” the scraper returns
  // subtitles: null). There are no spoken lines to quote, so GLM cannot pick
  // "the strongest line". Fall back to cut-aligned visual windows and let GLM
  // only name the hooks â€” see buildVisualPlan below.
  if (!intel.transcript?.length) {
    return buildVisualPlan(intel, rules, visualContext);
  }

  const userPayload = {
    title: intel.title,
    durationSec: intel.durationSec,
    transcript: intel.transcript,
    rules,
    targetPlatforms: targetPlatforms ?? null,
    styleProfile: styleProfile ?? null,
    // Visual intelligence extracted from the actual video file (optional):
    // exact scene-cut timestamps + vision-model notes per sampled frame.
    visualContext: visualContext
      ? {
          sceneCuts: visualContext.sceneCuts,
          frameNotes: visualContext.frameNotes,
        }
      : null,
  };

  const completion = await glmClient().chat.completions.create({
    model: process.env.NVIDIA_GLM_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b",
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt?.trim() || DEFAULT_EDIT_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed: Omit<EditPlan, "sourceVideoPath">;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`GLM did not return valid JSON edit plan: ${String(err)}`);
  }

  return {
    sourceVideoPath: intel.videoFilePath,
    sourceUrl: intel.sourceUrl,
    clips: parsed.clips ?? [],
  };
}

/**
 * Builds a StyleProfile from a reference/sample video's own VideoIntel by
 * asking GLM to describe its cutting rhythm and caption style in the
 * structured shape Remotion + the edit-plan prompt expect. This is the
 * text-based stand-in for "watch this video and copy its technique" â€”
 * see the note in lib/types.ts.
 */
export async function extractStyleProfile(sampleIntel: VideoIntel): Promise<StyleProfile> {
  const completion = await glmClient().chat.completions.create({
    model: process.env.NVIDIA_GLM_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b",
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: `Given a transcript with timestamps and (if present) scene cut
times for a short-form video, infer its editing style. Respond with ONLY
valid JSON matching:
type StyleProfile = {
  avgCutLengthSec: number;
  captionStyle: { position: "bottom"|"center"|"top"; wordsPerCaption: number; highlightActiveWord: boolean; fontHint: string };
  zoomRhythm: { zoomEverySec: number; zoomIntensity: number };
  notes: string;
};`,
      },
      {
        role: "user",
        content: JSON.stringify({
          durationSec: sampleIntel.durationSec,
          sceneCuts: sampleIntel.sceneCuts ?? [],
          transcript: sampleIntel.transcript,
        }),
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

/**
 * Vision-based version of extractStyleProfile: actually looks at frames
 * pulled from the sample video (via ffmpeg) instead of only inferring style
 * from transcript/scene-cut timestamps. Use this once you have access to a
 * vision-capable model on build.nvidia.com â€” set NVIDIA_VISION_MODEL to its
 * exact catalog ID (e.g. "meta/llama-3.2-11b-vision-instruct",
 * "nvidia/llama-3.1-nemotron-nano-vl-8b-v1", or a Qwen-VL variant â€” check
 * build.nvidia.com/models for what's currently available and confirm the ID
 * on the model's own page, since the catalog changes over time).
 *
 * IMPORTANT: hosted build.nvidia.com vision endpoints accept AT MOST ONE
 * image per prompt â€” putting all frames into one request answers 400
 * "At most 1 image(s) may be provided in one prompt". So every frame is
 * described in its OWN request (one image each, batched concurrently with a
 * hard deadline, per-frame best-effort â€” same pattern as the frame scanner in
 * lib/visualScan.ts), and the per-frame JSON observations are merged here
 * into one StyleProfile. Cut pacing is MEASURED with ffmpeg's scene detector
 * instead of guessed from stills.
 */
export async function extractStyleProfileVision(
  sampleIntel: VideoIntel,
  frameCount = 8
): Promise<StyleProfile> {
  const visionModel =
    process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct";
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error(
      "NVIDIA_API_KEY is not set â€” pick a vision-capable model ID on build.nvidia.com"
    );
  }

  const frames = await extractFramesAsDataUris(
    sampleIntel.videoFilePath,
    sampleIntel.durationSec,
    frameCount
  );
  if (!frames.length) {
    throw new Error("ffmpeg extracted no frames from the sample video");
  }

  // Real cut pacing: ffmpeg's scene detector over the whole sample (stills
  // alone can't show pacing). Best-effort â€” neutral fallback if it fails.
  let sceneCuts: number[] = [];
  try {
    sceneCuts = await detectSceneCuts(sampleIntel.videoFilePath);
  } catch {
    sceneCuts = [];
  }
  const dur = sampleIntel.durationSec > 0 ? sampleIntel.durationSec : 30;
  const avgCutLengthSec =
    sceneCuts.length > 0
      ? +(dur / (sceneCuts.length + 1)).toFixed(2)
      : +(dur / (frames.length + 1)).toFixed(2);

  interface FrameStyle {
    captionPosition: "bottom" | "center" | "top" | "none";
    wordsPerCaption: number;
    highlightActiveWord: boolean;
    fontHint: string;
    framing: string;
    zoomHint: string;
    notes: string;
  }

  // ONE image per request â€” the hosted endpoint's hard limit.
  async function describeFrame(
    dataUri: string,
    index: number
  ): Promise<FrameStyle | null> {
    try {
      const completion = await withRetry(
        () =>
          glmClient().chat.completions.create({
            model: visionModel,
            temperature: 0.2,
            max_tokens: 400,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: `This is frame ${index + 1} of ${frames.length}, sampled evenly across a short-form video (${dur}s total). Describe only the editing style visible in THIS single frame. Respond with ONLY valid JSON:
{"captionPosition":"bottom|center|top|none","captionText":"visible caption text or empty","wordsPerCaption":0,"highlightActiveWord":false,"fontHint":"font/color/box description or empty","framing":"wide|medium|close","zoomHint":"static|push-in|pull-out|unclear","notes":"one short sentence on visual style"}`,
                  },
                  { type: "image_url", image_url: { url: dataUri } },
                ],
              },
            ],
          }),
        1
      );
      const raw = (completion.choices[0]?.message?.content ?? "").replace(
        /```json|```/g,
        ""
      );
      let obj: any = null;
      try {
        obj = JSON.parse(raw.trim());
      } catch {
        const m = raw.match(/\{[\s\S]*\}/);
        if (m) obj = JSON.parse(m[0]);
      }
      if (!obj || typeof obj !== "object") return null;
      const pos = String(obj.captionPosition ?? "none").toLowerCase();
      return {
        captionPosition: (["bottom", "center", "top"].includes(pos)
          ? pos
          : "none") as FrameStyle["captionPosition"],
        wordsPerCaption: Math.max(
          0,
          Math.round(Number(obj.wordsPerCaption) || 0)
        ),
        highlightActiveWord: Boolean(obj.highlightActiveWord),
        fontHint: String(obj.fontHint ?? "").slice(0, 120),
        framing: String(obj.framing ?? "").toLowerCase().slice(0, 20),
        zoomHint: String(obj.zoomHint ?? "unclear").toLowerCase().slice(0, 20),
        notes: String(obj.notes ?? "").slice(0, 300),
      };
    } catch {
      return null; // per-frame best-effort
    }
  }

  // Bounded batches of 3 with a hard deadline: whatever descriptions arrive
  // before the deadline are used (mirrors lib/visualScan.ts).
  const results: (FrameStyle | null)[] = new Array(frames.length).fill(null);
  const DEADLINE_MS = 90_000;
  const startedAt = Date.now();
  let cursor = 0;
  while (cursor < frames.length) {
    const remaining = DEADLINE_MS - (Date.now() - startedAt);
    if (remaining <= 0) break;
    const batch = frames
      .slice(cursor, cursor + 3)
      .map((uri, j) => ({ uri, idx: cursor + j }));
    cursor += batch.length;
    await Promise.race([
      Promise.all(
        batch.map(({ uri, idx }) =>
          describeFrame(uri, idx).then((r) => {
            results[idx] = r;
          })
        )
      ),
      new Promise<void>((resolve) => setTimeout(resolve, remaining + 1)),
    ]);
  }

  const got = results.filter(Boolean) as FrameStyle[];
  if (!got.length) {
    throw new Error(
      `The vision model "${visionModel}" returned nothing usable for any of the ` +
        `${frames.length} frames. Confirm NVIDIA_VISION_MODEL in .env.local is a ` +
        `vision-capable chat model on build.nvidia.com/models.`
    );
  }

  // Deterministic merge of per-frame observations into the StyleProfile.
  const mostCommon = (vals: string[]): string | undefined => {
    const counts = new Map<string, number>();
    for (const v of vals) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best: string | undefined;
    let bestN = 0;
    for (const [v, n] of counts) {
      if (n > bestN) {
        best = v;
        bestN = n;
      }
    }
    return best;
  };

  const captioned = got.filter((f) => f.captionPosition !== "none");
  const position = mostCommon(captioned.map((f) => f.captionPosition)) as
    | StyleProfile["captionStyle"]["position"]
    | undefined;
  const wordCounts = captioned
    .map((f) => f.wordsPerCaption)
    .filter((n) => n > 0);
  const uniqueFonts = Array.from(
    new Set(got.map((f) => f.fontHint).filter(Boolean))
  ).slice(0, 3);
  const zoomPushes = got.filter((f) => f.zoomHint === "push-in").length;
  const framingChanges = got.filter(
    (f, i) => i > 0 && f.framing && got[i - 1].framing && f.framing !== got[i - 1].framing
  ).length;

  return {
    avgCutLengthSec,
    captionStyle: {
      position: position ?? "bottom",
      wordsPerCaption: wordCounts.length
        ? Math.max(
            1,
            Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length)
          )
        : 4,
      highlightActiveWord:
        got.filter((f) => f.highlightActiveWord).length > got.length / 2,
      fontHint: uniqueFonts.join("; ").slice(0, 120),
    },
    zoomRhythm: {
      // Punch-ins typically land on cuts, so reuse the measured cut pace.
      zoomEverySec: +avgCutLengthSec.toFixed(1),
      // Subtle by default; nudged up when frames suggest push-ins or big
      // framing swings (intensity can't be measured from stills perfectly).
      zoomIntensity: Math.min(
        0.6,
        0.1 + (zoomPushes > 0 ? 0.1 : 0) + (framingChanges > 1 ? 0.1 : 0)
      ),
    },
    notes:
      `Vision pass: ${got.length}/${frames.length} frames described ` +
      `one-per-prompt; ${captioned.length} showed captions. ` +
      got
        .map((f) => f.notes)
        .filter(Boolean)
        .slice(0, 5)
        .join(" ")
        .slice(0, 600),
  };
}

/**
 * Fallback edit plan for videos with NO transcript (captions: null â€” e.g.
 * music-only sports highlight reels). The creator's rules are all about
 * picking the strongest spoken lines, which is impossible without captions,
 * so:
 * - clip windows are chosen by VISUAL content: when a VisualContext is
 *   available, windows are built from the scene cuts and the vision-model
 *   interest notes (highest-interest moments, snapped to real cuts); without
 *   it they fall back to evenly-spaced windows (GLM never invents timestamps),
 * - GLM is asked ONLY for punchy hook titles (inferable from the title),
 * - captions stay empty (nothing is spoken),
 * - zoom keyframes follow a fixed subtle push-in rhythm.
 */
async function buildVisualPlan(
  intel: VideoIntel,
  rules: EditRules,
  visualContext?: VisualContext | null
): Promise<EditPlan> {
  const count = Math.max(1, Math.min(rules.targetClipCount || 3, 6));
  const dur = intel.durationSec > 0 ? intel.durationSec : 600;
  const maxSpan = Math.min(rules.maxClipSec || 45, dur / count);
  const span = Math.max(maxSpan, Math.min(rules.minClipSec || 20, maxSpan));

  // Pick visual windows: use scene cuts + vision interest when available.
  const windows: [number, number][] = [];
  const sceneCuts = visualContext?.sceneCuts ?? [];
  const frameNotes = visualContext?.frameNotes ?? [];
  if (sceneCuts.length) {
    // Candidate segments = everything between consecutive cuts, plus the
    // whole video if no cuts. Score each by the peak interest of any frame
    // note inside it (fallback: 50 + length bonus for longer segments).
    const bounds = [0, ...sceneCuts, dur];
    const candidates: { start: number; end: number; score: number }[] = [];
    for (let i = 0; i < bounds.length - 1; i++) {
      const s = bounds[i];
      const e = bounds[i + 1];
      const len = e - s;
      if (len < 3) continue;
      const peak = Math.max(
        50,
        ...frameNotes
          .filter((f) => f.atSec >= s && f.atSec < e)
          .map((f) => f.interest)
      );
      const score = peak + Math.min(len / dur, 0.5) * 40;
      candidates.push({ start: s, end: e, score });
    }
    // Greedy, non-overlapping pick of the highest-scoring segments.
    candidates.sort((a, b) => b.score - a.score);
    const picked: typeof candidates = [];
    for (const cand of candidates) {
      const overlaps = picked.some(
        (p) => cand.start < p.end - 1 && cand.end > p.start + 1
      );
      if (!overlaps) {
        picked.push(cand);
        if (picked.length >= count) break;
      }
    }
    picked.sort((a, b) => a.start - b.start);
    for (const p of picked) {
      // Keep segment length within [min, max] clip span centered on its peak.
      const mid = (p.start + p.end) / 2;
      let s = Math.max(0, mid - span / 2);
      let e = Math.min(dur, mid + span / 2);
      [s, e] = snapToSceneCuts(s, e, sceneCuts);
      windows.push([s, e]);
    }
  }

  // Fallback: no / too few visual windows â†’ even spread.
  if (windows.length < count) {
    const usable = Math.max(dur - span, 1);
    for (let i = 0; i < count; i++) {
      const start = Math.max(
        0,
        Math.round((usable / count) * i + (usable / count - span) / 2)
      );
      const end = Math.min(dur, start + span);
      windows.push([start, end]);
    }
  }

  const clips: ClipPlan[] = windows.slice(0, count).map(([start, end], i) => ({
    clipId: `clip-${i + 1}`,
    sourceStartSec: start,
    sourceEndSec: end,
    hookTitle: "",
    captions: [] as CaptionCue[],
    zoomKeyframes: [
      { atSec: 0, scale: 1.0, focusX: 0.5, focusY: 0.45 },
      { atSec: +((end - start) * 0.5).toFixed(2), scale: 1.12, focusX: 0.5, focusY: 0.5 },
      { atSec: end - start, scale: 1.05, focusX: 0.5, focusY: 0.5 },
    ],
  }));

  // Hook titles: GLM names each window punchily from the video title alone.
  try {
    const completion = await glmClient().chat.completions.create({
      model: process.env.NVIDIA_GLM_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b",
      temperature: 0.6,
      messages: [
        {
          role: "system",
          content:
            "You write punchy short-form video hook titles. Respond ONLY with a JSON array of strings, one per clip, in order. Max 40 chars each.",
        },
        {
          role: "user",
          content: JSON.stringify({
            videoTitle: intel.title,
            creatorRules: rules.instructions,
            clipCount: clips.length,
            windows: clips.map((c) => [c.sourceStartSec, c.sourceEndSec]),
            hint: "No captions exist for this video (no speech). Write hooks that work for silent visual moments.",
          }),
        },
      ],
    });
    const parsed = JSON.parse(
      (completion.choices[0]?.message?.content ?? "[]")
        .replace(/```json|```/g, "")
        .trim()
    );
    if (Array.isArray(parsed)) {
      clips.forEach((c, i) => {
        if (typeof parsed[i] === "string" && parsed[i].trim()) {
          c.hookTitle = parsed[i].trim().slice(0, 80);
        }
      });
    }
  } catch {
    // network blip etc â€” the deterministic fallback titles below still apply
  }

  clips.forEach((c, i) => {
    if (!c.hookTitle) {
      c.hookTitle = (intel.title ?? "").slice(0, 60) || `Clip ${i + 1}`;
    }
  });

  return { sourceVideoPath: intel.videoFilePath, sourceUrl: intel.sourceUrl, clips };
}
