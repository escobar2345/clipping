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

export interface ClipPlan {
  clipId: string;
  sourceStartSec: number;
  sourceEndSec: number;
  hookTitle: string;
  captions: CaptionCue[];
  zoomKeyframes: ZoomKeyframe[];
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
