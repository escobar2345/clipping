import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import os from "os";

const execFileAsync = promisify(execFile);

/**
 * Extracts `count` evenly-spaced JPEG frames from a video file/URL and
 * returns them as base64 data URIs, ready to drop into an OpenAI-style
 * `image_url` content block. Requires ffmpeg to be installed and on PATH.
 *
 * Note: this pulls frames rather than sending raw video, because the
 * hosted build.nvidia.com chat/completions endpoint takes images
 * (`image_url` blocks), not a video stream — see README for details.
 */
export async function extractFramesAsDataUris(
  videoPath: string,
  durationSec: number,
  count = 8
): Promise<string[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "frames-"));
  const uris: string[] = [];

  try {
    const step = Math.max(durationSec / (count + 1), 0.5);
    for (let i = 1; i <= count; i++) {
      const t = (step * i).toFixed(2);
      const outFile = path.join(tmpDir, `frame-${i}.jpg`);
      await execFileAsync("ffmpeg", [
        "-ss", t,
        "-i", videoPath,
        "-frames:v", "1",
        "-q:v", "3",
        "-y",
        outFile,
      ]);
      const buf = fs.readFileSync(outFile);
      uris.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return uris;
}

/** Helper: extraction of frames at *specific* times.
 *  Returns frames as JPEG data URIs (scaled down to maxWidth to keep the
 *  vision-model payload light). Times should already be sanity-checked. */
export async function extractFramesAtTimes(
  videoPath: string,
  times: number[],
  maxWidth = 640
): Promise<{ atSec: number; dataUri: string }[]> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "frames-at-"));
  const out: { atSec: number; dataUri: string }[] = [];
  try {
    for (const t of times) {
      const outFile = path.join(tmpDir, `f-${t.toFixed(2)}.jpg`);
      try {
        await execFileAsync(
          "ffmpeg",
          [
            "-ss", t.toFixed(3),
            "-i", videoPath,
            "-frames:v", "1",
            "-vf", `scale=${maxWidth}:-2`,
            "-q:v", "4",
            "-y", outFile,
          ],
          { timeout: 20_000, windowsHide: true }
        );
        const buf = fs.readFileSync(outFile);
        out.push({ atSec: t, dataUri: `data:image/jpeg;base64,${buf.toString("base64")}` });
      } catch {
        // skip frames that can't be extracted
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return out;
}

/**
 * Returns a video's duration in seconds using ffprobe. Used to evenly space
 * sampled frames when the duration isn't already known — e.g. an uploaded
 * reference clip that never went through Apify. Requires ffprobe on PATH
 * (it ships with ffmpeg). Returns 0 if the duration can't be read.
 */
export async function getVideoDurationSec(videoPath: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoPath,
  ]);
  const dur = parseFloat(stdout.trim());
  return Number.isFinite(dur) ? dur : 0;
}
