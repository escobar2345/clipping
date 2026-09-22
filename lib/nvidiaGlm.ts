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
import { snapToSceneCuts } from "./visualScan";
import { DEFAULT_EDIT_SYSTEM_PROMPT } from "./prompts";
import { normalizeClips } from "./planNormalize";

// build.nvidia.com exposes GLM (and many other) models behind an
// OpenAI-compatible /v1/chat/completions endpoint, so the official `openai`
// SDK works as-is — just point baseURL at NVIDIA and use your NVIDIA key.
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
// and can be overridden per-run — generateEditPlan takes an optional
// systemPrompt argument that the UI (and the /api/edit-plan route) supplies.

export async function generateEditPlan(
  intel: VideoIntel,
  rules: EditRules,
  styleProfile?: StyleProfile,
  systemPrompt?: string,
  visualContext?: VisualContext | null
): Promise<EditPlan> {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error(
      "NVIDIA_API_KEY is not set in your environment — get a key at build.nvidia.com"
    );
  }

  // No transcript? (music-only compilations etc. — the scraper returns
  // subtitles: null). There are no spoken lines to quote, so GLM cannot pick
  // "the strongest line". Fall back to cut-aligned visual windows and let GLM
  // only name the hooks — see buildVisualPlan below.
  if (!intel.transcript?.length) {
    return buildVisualPlan(intel, rules, visualContext);
  }

  const userPayload = {
    title: intel.title,
    durationSec: intel.durationSec,
    transcript: intel.transcript,
    rules,
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
    model: process.env.NVIDIA_GLM_MODEL ?? "deepseek-ai/deepseek-v4-pro-0813",
    temperature: 0.4,
    messages: [
      { role: "system", content: systemPrompt?.trim() || DEFAULT_EDIT_SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  const cleaned = raw.replace(/```json|```/g, "").trim();

  let parsed: any;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`GLM did not return valid JSON edit plan: ${String(err)}`);
  }

  // Never hand the renderer raw model output: validate it, fix the time base,
  // snap to word boundaries, enforce min/max length, rebuild captions from the
  // real transcript. See lib/planNormalize.ts.
  const { clips, warnings } = normalizeClips(
    Array.isArray(parsed) ? parsed : parsed?.clips,
    intel,
    rules
  );
  if (!clips.length) {
    throw new Error(
      "The model's edit plan had no usable clips" +
        (warnings.length ? ` (${warnings.join(" ")})` : "") +
        ". Try again or loosen the rules."
    );
  }

  return {
    sourceVideoPath: intel.videoFilePath,
    sourceUrl: intel.sourceUrl,
    clips,
    warnings,
  };
}

/**
 * Builds a StyleProfile from a reference/sample video's own VideoIntel by
 * asking GLM to describe its cutting rhythm and caption style in the
 * structured shape Remotion + the edit-plan prompt expect. This is the
 * text-based stand-in for "watch this video and copy its technique" —
 * see the note in lib/types.ts.
 */
export async function extractStyleProfile(sampleIntel: VideoIntel): Promise<StyleProfile> {
  const completion = await glmClient().chat.completions.create({
    model: process.env.NVIDIA_GLM_MODEL ?? "deepseek-ai/deepseek-v4-pro-0813",
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
 * vision-capable model on build.nvidia.com — set NVIDIA_VISION_MODEL to its
 * exact catalog ID (e.g. "meta/llama-3.2-11b-vision-instruct",
 * "nvidia/llama-3.1-nemotron-nano-vl-8b-v1", or a Qwen-VL variant — check
 * build.nvidia.com/models for what's currently available and confirm the ID
 * on the model's own page, since the catalog changes over time).
 *
 * This sends still frames, not raw video: the hosted chat/completions
 * endpoint takes `image_url` content blocks, and reliable raw-video input
 * is documented for self-hosted NIM containers with video input explicitly
 * enabled, not confirmed for the shared hosted endpoint.
 */
export async function extractStyleProfileVision(
  sampleIntel: VideoIntel,
  frameCount = 8
): Promise<StyleProfile> {
  const visionModel =
    process.env.NVIDIA_VISION_MODEL || "meta/llama-3.2-11b-vision-instruct";
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error(
      "NVIDIA_API_KEY is not set — pick a vision-capable model ID on build.nvidia.com"
    );
  }

  const frames = await extractFramesAsDataUris(
    sampleIntel.videoFilePath,
    sampleIntel.durationSec,
    frameCount
  );

  const completion = await glmClient().chat.completions.create({
    model: visionModel,
    temperature: 0.2,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `These are evenly-spaced frames sampled across a short-form
video, in chronological order. Look at caption placement/style, framing,
zoom/crop choices, and overall pacing implied by what's visible across the
frames. Respond with ONLY valid JSON matching:
type StyleProfile = {
  avgCutLengthSec: number;
  captionStyle: { position: "bottom"|"center"|"top"; wordsPerCaption: number; highlightActiveWord: boolean; fontHint: string };
  zoomRhythm: { zoomEverySec: number; zoomIntensity: number };
  notes: string;
};
Video duration is ${sampleIntel.durationSec} seconds. Use the notes field for
anything about visual style (font look, color, caption boxes, transitions)
that doesn't fit the other fields.`,
          },
          ...frames.map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ],
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

/**
 * Fallback edit plan for videos with NO transcript (captions: null — e.g.
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

  // Fallback: no / too few visual windows → even spread.
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
      model: process.env.NVIDIA_GLM_MODEL ?? "deepseek-ai/deepseek-v4-pro-0813",
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
    // network blip etc — the deterministic fallback titles below still apply
  }

  clips.forEach((c, i) => {
    if (!c.hookTitle) {
      c.hookTitle = (intel.title ?? "").slice(0, 60) || `Clip ${i + 1}`;
    }
  });

  return { sourceVideoPath: intel.videoFilePath, sourceUrl: intel.sourceUrl, clips };
}
