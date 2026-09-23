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
