/**
 * Checks if a URL is a YouTube URL.
 */
export function isYouTubeUrl(url: string): boolean {
  return /youtu\.be\/|youtube\.com\/(watch|v|shorts|embed)/.test(url);
}

export interface DownloadResult {
  /** Local filesystem path or a URL Remotion can read. */
  fileUrl: string;
  /** Optional metadata from the source platform. */
  metadata?: Record<string, any>;
}

/**
 * Downloads a video from any URL (TikTok, Instagram, Vimeo, direct mp4, etc.)
 * to a local file.
 *
 * ⚠ This stub throws. In production, use yt-dlp or a platform-specific
 *   library to download and normalize the video to mp4.
 */
export async function ensureVideoFileAnyUrl(url: string): Promise<DownloadResult> {
  if (isYouTubeUrl(url)) {
    throw new Error("Use ensureVideoFile() for YouTube URLs — not ensureVideoFileAnyUrl().");
  }

  throw new Error(
    "ensureVideoFileAnyUrl: Download from arbitrary URLs not implemented in this build. " +
    "Install yt-dlp and implement the download step."
  );
}
