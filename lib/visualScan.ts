import type { VideoIntel, VisualContext } from "./types";

/**
 * Builds visual context from a video file:
 *  - Scene cuts (ffmpeg frame-by-frame detection)
 *  - Vision-model notes on sampled frames (events, on-screen text, interest score)
 *
 * Returns null when the video file isn't local or ffmpeg isn't available.
 * The edit-plan route treats null as "no visual bonus" and falls back to
 * transcript-only planning.
 */
export async function buildVisualContext(intel: VideoIntel): Promise<VisualContext | null> {
  // Stub: full implementation uses ffmpeg for scene detection and a vision
  // model for frame analysis. Returns null so the pipeline falls back to
  // transcript-only planning.
  return null;
}

/**
 * Converts a video URL or local path to a local filesystem path if the
 * video is already stored locally on disk.
 *
 * Returns null for remote URLs that haven't been downloaded yet.
 */
export function videoUrlToLocalPath(videoPath: string): string | null {
  // Local file paths (no protocol) are already local
  if (!videoPath.startsWith("http://") && !videoPath.startsWith("https://")) {
    return videoPath;
  }
  // Check if the URL points to a local file under public/
  if (videoPath.includes("/public/")) {
    return videoPath;
  }
  return null;
}

/**
 * Snaps a clip's [start, end] boundaries to the nearest scene cuts within
 * a ~2.5s window, so cuts never land mid-shot.
 *
 * @returns [adjustedStart, adjustedEnd]
 */
export function snapToSceneCuts(
  start: number,
  end: number,
  sceneCuts: number[]
): [number, number] {
  if (!sceneCuts.length) return [start, end];

  const SNAP_WINDOW = 2.5;
  let newStart = start;
  let newEnd = end;

  for (const cut of sceneCuts) {
    if (cut < start || cut > end) continue;
    if (Math.abs(cut - start) <= SNAP_WINDOW) newStart = cut;
    if (Math.abs(cut - end) <= SNAP_WINDOW) newEnd = cut;
  }

  return [newStart, newEnd];
}
