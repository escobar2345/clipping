import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Extracts evenly-spaced frames from a video as base64 data URIs using ffmpeg.
 *
 * Used for vision-based style extraction: each frame is sent individually to
 * a vision-capable model on build.nvidia.com (the hosted endpoint accepts
 * at most 1 image per request).
 *
 * @param videoPath   Path to the local video file.
 * @param durationSec Total duration of the video in seconds.
 * @param frameCount  How many frames to extract (default 8).
 * @returns Data URIs like "data:image/jpeg;base64,/9j/...".
 */
export async function extractFramesAsDataUris(
  videoPath: string,
  durationSec: number,
  frameCount: number = 8
): Promise<string[]> {
  // Stub: full implementation uses ffmpeg to extract frames at even
  // intervals and base64-encode them as data URIs.
  // Returns an empty array so vision-based style extraction produces
  // no frame analysis (text-only path still works).
  return [];
}

/**
 * A video's duration in seconds, read with ffprobe (ships with ffmpeg).
 * Used for uploaded files that never went through Apify, so their duration
 * isn't already known. Returns 0 when the duration can't be read.
 */
export async function getVideoDurationSec(videoPath: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      videoPath,
    ]);
    const dur = parseFloat(String(stdout).trim());
    return Number.isFinite(dur) ? dur : 0;
  } catch {
    return 0; // ffprobe missing or file unreadable — callers fall back
  }
}
