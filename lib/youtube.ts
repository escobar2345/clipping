import path from "path";
import fs from "fs";

/**
 * Downloads a YouTube video to a local .mp4 file and returns the path.
 *
 * The file is cached in `public/uploads/<videoId>.mp4` so each video
 * is downloaded exactly once across analyze, plan, and render steps.
 *
 * ⚠ This stub throws when the file isn't already cached. In production,
 *   integrate yt-dlp (or a YouTube library) to perform the actual download.
 */
export async function ensureVideoFile(youtubeUrl: string): Promise<string> {
  const m = youtubeUrl.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/);
  const videoId = m ? m[1] : "unknown";

  const uploadsDir = path.join(process.cwd(), "public", "uploads");
  fs.mkdirSync(uploadsDir, { recursive: true });

  const localPath = path.join(uploadsDir, `${videoId}.mp4`);

  if (fs.existsSync(localPath)) return localPath;

  throw new Error(
    "ensureVideoFile: YouTube download not implemented in this build. " +
    "Install yt-dlp and implement the download step."
  );
}
