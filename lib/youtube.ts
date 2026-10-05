import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { uploadsDir } from "./userPaths";
import type { TranscriptWord } from "./types";
import { parseSubtitleText } from "./subtitles";
import { downloadMedia, probeMetadata, ytdlpVersion } from "./ytdlp";

/**
 * Downloads a YouTube video to a local file and returns its path.
 *
 * The file is cached in `public/uploads/<videoId>.<ext>`, so each video is
 * downloaded exactly once across the analyze / plan / render steps.
 *
 * Download happens through yt-dlp (see lib/ytdlp.ts). It is LAZY: analyze only
 * reads metadata + captions, and the pixels are pulled here at render time.
 */

/**
 * public/uploads/<userId> — the on-disk cache shared by analyze, plan and
 * render for whichever user is signed in. Resolved per call, never cached at
 * module scope, so two concurrent requests can't land in each other's folder.
 */
export { uploadsDir };

/**
 * Extracts the 11-character video id from any common YouTube URL shape
 * (watch?v=, youtu.be/, /shorts/, /embed/, /live/, with or without extra
 * query params). Returns null when the URL isn't a recognisable video link.
 */
export function extractVideoId(url: string): string | null {
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})/,
    /youtube(?:-nocookie)?\.com\/(?:embed|v|shorts|live)\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/clip\/[A-Za-z0-9_-]+\?.*v=([A-Za-z0-9_-]{11})/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  // A bare 11-character id typed straight into the box.
  const bare = url.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(bare)) return bare;
  return null;
}

/** Cached caption file for a video id, if a previous download fetched one. */
function findCachedSubtitle(videoId: string): string | null {
  const dir = uploadsDir();
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(videoId)) continue;
    const ext = path.extname(entry).toLowerCase();
    if (![".vtt", ".srt", ".json3", ".srv3", ".ttml"].includes(ext)) continue;
    return path.join(dir, entry);
  }
  return null;
}

/** Path of the cached video for this id, or null when not downloaded yet. */
export function cachedVideoPath(videoId: string): string | null {
  const dir = uploadsDir();
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(videoId)) continue;
    const ext = path.extname(entry).toLowerCase();
    if (![".mp4", ".m4v", ".mov", ".webm", ".mkv"].includes(ext)) continue;
    const full = path.join(dir, entry);
    try {
      if (fs.statSync(full).size > 0) return full;
    } catch {
      /* unreadable — treat as absent */
    }
  }
  return null;
}

/**
 * Title/duration for a YouTube URL without downloading the video.
 * Used by analyze when the Apify actor doesn't supply them.
 */
export async function fetchYouTubeMetadata(url: string) {
  const meta = await probeMetadata(url);
  if (!meta) return null;
  return {
    title: typeof meta.title === "string" ? meta.title : undefined,
    durationSec:
      typeof meta.duration === "number" && Number.isFinite(meta.duration) ? meta.duration : undefined,
  };
}

/**
 * YouTube's own caption track, parsed to word timings.
 *
 * Used as the transcript when the Apify actor returns none — the captions are
 * free and usually more accurate than auto-generated Deepgram timing. Returns
 * [] when there are no captions or nothing has been downloaded yet (no network
 * call is made here; it only reads what a download already left on disk).
 */
export function cachedYouTubeTranscript(videoId: string): TranscriptWord[] {
  const sub = findCachedSubtitle(videoId);
  if (!sub) return [];
  try {
    return parseSubtitleText(fs.readFileSync(sub, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Absolute localhost URL the headless Chromium can fetch during rendering.
 * Kept next to the upload/download helpers because the upload routes hand
 * freshly written files to Remotion through it.
 */
export function localFileUrl(relPath: string): string {
  const port = process.env.PORT || "3000";
  return `http://127.0.0.1:${port}${relPath.startsWith("/") ? relPath : `/${relPath}`}`;
}

/**
 * If yt-dlp produced .webm/.mkv/... instead of .mp4, remux it into an .mp4 with
 * an ffmpeg stream copy (fast, no re-encode) so Remotion always gets an mp4.
 * Deliberately ignores subtitle files (`<id>.en.vtt`) and `.part` fragments.
 *
 * Returns true when `<dir>/<id>.mp4` exists afterwards.
 */
export function remuxIfNeeded(dir: string, id: string): boolean {
  const VIDEO_EXT = /\.(webm|mkv|mov|avi|flv|m4v|ts)$/i;
  const finalPath = path.join(dir, `${id}.mp4`);
  const candidates = fs
    .readdirSync(dir)
    .filter(
      (f) =>
        f.startsWith(`${id}.`) &&
        !f.endsWith(".mp4") &&
        !f.endsWith(".part") &&
        !f.endsWith(".ytdl") &&
        VIDEO_EXT.test(f)
    );
  if (!candidates.length) {
    try {
      return fs.statSync(finalPath).size > 0;
    } catch {
      return false;
    }
  }
  try {
    execFileSync(
      "ffmpeg",
      ["-y", "-i", path.join(dir, candidates[0]), "-c", "copy", finalPath],
      { windowsHide: true, timeout: 120_000 }
    );
    return true;
  } catch {
    return false;
  }
}

/** Whether yt-dlp is usable — surfaced by the API so the UI can warn early. */
export function ytDlpAvailable(): Promise<string | null> {
  return ytdlpVersion();
}

/**
 * Ensures a local copy of the YouTube video exists and returns its path.
 * Throws with an actionable message when the id can't be parsed or yt-dlp
 * can't fetch it (private, geo-blocked, age-restricted, removed).
 */
export async function ensureVideoFile(youtubeUrl: string): Promise<string> {
  const videoId = extractVideoId(youtubeUrl);
  if (!videoId) {
    throw new Error(
      `Could not find a YouTube video id in "${youtubeUrl}". ` +
        `Paste a full link (e.g. https://www.youtube.com/watch?v=...) or a youtu.be short link.`
    );
  }

  const cached = cachedVideoPath(videoId);
  if (cached) return cached;

  const { file } = await downloadMedia({
    url: youtubeUrl,
    outDir: uploadsDir(),
    outName: videoId,
  });
  return file;
}
