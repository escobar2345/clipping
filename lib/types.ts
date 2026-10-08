// Shared types passed between Apify -> GLM -> Remotion

// One connected social channel inside a single Buffer account.
export interface BufferChannel {
  id: string;
  service: string; // e.g. "instagram", "tiktok", "youtube_shorts", "x"
  displayName: string;
}

export interface TranscriptWord {
  word: string;
  start: number; // seconds
  end: number; // seconds
  /** true when the time was ESTIMATED (a caption cue's window spread evenly
   *  over its words) rather than measured. Cutting on estimated times would
   *  land in the wrong places, so silence/filler tightening skips these. */
  estimated?: boolean;
}

export interface VideoIntel {
  sourceUrl: string;
  title: string;
  durationSec: number;
  videoFilePath: string; // local path or remote URL Remotion can read
  transcript: TranscriptWord[];
  // Coarse scene cut timestamps if the Apify actor / ffmpeg pass provides them
  sceneCuts?: number[];
}

// Optional "editing style" extracted from a sample video the user provides.
// This is what stands in for "let the AI copy this video's editing technique" —
// we describe the sample's rhythm/captions/zoom pattern as data, since a
// text-only GLM endpoint can't watch raw video frames.
export interface StyleProfile {
  avgCutLengthSec: number;
  captionStyle: {
    position: "bottom" | "center" | "top";
    wordsPerCaption: number;
    highlightActiveWord: boolean;
    fontHint: string;
  };
  zoomRhythm: {
    zoomEverySec: number;
    zoomIntensity: number; // 0-1
  };
  notes: string;
}

export interface EditRules {
  // Free text the user can change between runs, e.g.
  // "prioritize punchy one-liners", "keep clips under 40s", "no zoom on faces"
  instructions: string;
  targetClipCount: number;
  minClipSec: number;
  maxClipSec: number;
  aspect: "9:16";
}

/** One spoken word inside a caption cue. Times are seconds RELATIVE TO THE
 *  CLIP START (0 = clip.sourceStartSec), same time base as the cue itself. */
export interface CaptionWord {
  text: string;
  startSec: number;
  endSec: number;
}

export interface CaptionCue {
  text: string;
  /** Seconds relative to the clip start (NOT the source video). */
  startSec: number;
  endSec: number;
  emphasizeWordIndex?: number;
  /** Per-word timing, used for active-word highlighting. Optional so plans
   *  from older runs (or LLM-written captions) still render as plain text. */
  words?: CaptionWord[];
}

/** A piece of the source video that stays in a tightened clip. ABSOLUTE
 *  source-video seconds. */
export interface KeepSegment {
  startSec: number;
  endSec: number;
}

/** Where the subject (a face) is, as a fraction of the SOURCE frame, at a time
 *  on the finished clip's timeline. Used to pan the 9:16 crop. */
export interface CropKeyframe {
  atSec: number;
  x: number;
  y: number;
}

export interface ZoomKeyframe {
  /** Seconds relative to the clip start. */
  atSec: number;
  scale: number; // 1 = no zoom
  focusX: number; // 0-1 normalized
  focusY: number; // 0-1 normalized
}

/** Color grade ("look") baked into the clip at render time. All numeric
 *  fields are deltas from the ungraded source and OPTIONAL — a bare
 *  `{ preset: "cinematic" }` is a complete grade. `intensity` (0-1) blends
 *  the whole look toward neutral. Resolved by lib/colorGrade.ts. */
export interface GradeSpec {
  /** Key into GRADE_PRESETS: cinematic | golden | moody | punchy | vibrant
   *  | vintage | noir | cold. */
  preset?: string;
  /** 0 = ungraded, 1 = full look (default 1). */
  intensity?: number;
  /** -0.5..0.5 */
  brightness?: number;
  /** -0.5..1 */
  contrast?: number;
  /** -1..1 (negative = desaturate toward B&W) */
  saturation?: number;
  /** -1 (cold/blue) .. 1 (warm/golden) */
  warmth?: number;
  /** 0..1 darkened corners */
  vignette?: number;
  /** 0..1 animated film grain */
  grain?: number;
}

/** A timed visual effect rendered over the clip (the After-Effects-style
 *  flair). Times are seconds RELATIVE TO THE CLIP START, same base as
 *  captions and zoom keyframes. Sanitized by lib/colorGrade.ts. */
export interface ClipEffect {
  type: "shake" | "flash" | "lightLeak";
  /** When the effect starts (default 0). */
  atSec?: number;
  /** Duration in seconds (defaults: flash 0.3, shake 0.8, lightLeak 2). */
  durSec?: number;
  /** 0..1 strength (default 0.8). */
  intensity?: number;
  /** flash only: hex colour, default white. */
  color?: string;
}

export interface ClipPlan {
  clipId: string;
  sourceStartSec: number;
  sourceEndSec: number;
  hookTitle: string;
  captions: CaptionCue[];
  zoomKeyframes: ZoomKeyframe[];
  /** Look applied to this clip at render time. Absent = ungraded. */
  grade?: GradeSpec;
  /** Timed visual effects (shake / flash / lightLeak) for this clip. */
  effects?: ClipEffect[];
  /** Tightened clip: only these source ranges play, back to back (silences and
   *  filler words are cut). Absent = play sourceStartSec..sourceEndSec as-is.
   *  Caption / zoom / crop times are on the EDITED timeline. */
  segments?: KeepSegment[];
  /** The creator's minimum clip length, kept so a later re-tighten (at render
   *  time) can respect it. */
  minLenSec?: number;
  /** Smart reframing: subject position over time so the 9:16 crop follows
   *  the speaker instead of always centring. Absent = centre crop. */
  crop?: {
    /** source width / source height */
    aspect: number;
    keyframes: CropKeyframe[];
  };
}

export interface EditPlan {
  sourceVideoPath: string;
  // The original link (YouTube or any platform) — lets /api/render fetch the
  // video file lazily when analyze was metadata-only (videoFilePath === "").
  sourceUrl?: string;
  clips: ClipPlan[];
  /** Non-fatal issues found while validating/normalizing the model's plan
   *  (clamped times, dropped clips, ...). Surfaced for debugging/UI. */
  warnings?: string[];
  /** Where the words the plan was built from came from. When "deepgram", the
   *  clip captions are already Deepgram-timed, so rendering doesn't call it
   *  again for each clip. */
  transcriptSource?: "captions" | "deepgram" | "none";
  /** AI-generated assets from Higgsfield MCP (B-roll, images, effects) */
  generatedAssets?: GeneratedAsset[];
}

export interface GeneratedAsset {
  /** Unique ID, e.g. "gf-clip-1-broll" */
  assetId: string;
  /** What kind of media */
  type: "video" | "image";
  /** URL to the generated media (remote, downloaded at render time) */
  url: string;
  /** What was asked Higgsfield to generate */
  prompt: string;
  /** Which Higgsfield tool was called */
  toolUsed: string;
  /** Which source clip this asset enhances */
  clipIndex?: number;
  /** Purpose of this asset in the edit */
  purpose: "broll" | "background" | "overlay" | "effect" | "upscale";
  /** Local path after download (populated at render time) */
  localPath?: string;
}

export interface FrameNote {
  atSec: number;
  /** Short vision-model summary of what's visible in this frame */
  events: string;
  /** On-screen text / scoreboard / captions visible (or "" if none) */
  onScreenText: string;
  /** 0-100 visual interest score from the vision model */
  interest: number;
}

/** Visual context extracted from the actual source video file. */
export interface VisualContext {
  /** Exact scene-cut timestamps detected frame-by-frame by ffmpeg. */
  sceneCuts: number[];
  /** Vision-model notes for sampled frames. */
  frameNotes: FrameNote[];
  /** Which source video these came from (videoFilePath at extraction time). */
  sourceFile: string;
}
