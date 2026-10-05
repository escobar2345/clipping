import fs from "fs";
import path from "path";
import { uploadsDir } from "./userPaths";
import { downloadMedia, probeMetadata, type MediaMetadata } from "./ytdlp";

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

// Downloads land in public/uploads/<userId>/ — resolved per call from the
// signed-in user, never captured at module scope.

/**
 * Short, filesystem-safe, collision-resistant name for a URL's media file.
 * YouTube-style ids are extracted when present so the name stays readable and
 * stable across runs; otherwise we hash the URL.
 */
function mediaSlug(url: string): string {
  const yt = url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})|v=([A-Za-z0-9_-]{6,})/);
  if (yt) return `yt-${yt[1] ?? yt[2]}`;
  let hash = 5381;
  for (let i = 0; i < url.length; i++) hash = ((hash << 5) + hash + url.charCodeAt(i)) >>> 0;
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-");
    } catch {
      return "media";
    }
  })();
  return `${host}-${hash.toString(36)}`;
}

function findByExt(dir: string, stem: string, exts: string[]): string | null {
  let best: { path: string; size: number } | null = null;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.startsWith(stem)) continue;
    if (entry.endsWith(".part") || entry.endsWith(".ytdl")) continue;
    if (!exts.includes(path.extname(entry).toLowerCase())) continue;
    const full = path.join(dir, entry);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      /* ignore */
    }
    if (!best || size > best.size) best = { path: full, size };
  }
  return best?.path ?? null;
}

const VIDEO_EXTS = [".mp4", ".m4v", ".mov", ".webm", ".mkv"];

/**
 * Downloads a video from any URL (TikTok, Instagram, Facebook, X, Vimeo, a
 * direct .mp4, ...) into `public/uploads` and returns the local path Remotion
 * can read. Cached by URL, so repeat renders of the same link cost nothing.
 *
 * Goes through yt-dlp (see lib/ytdlp.ts).
 */
export async function ensureVideoFileAnyUrl(url: string): Promise<DownloadResult> {
  if (isYouTubeUrl(url)) {
    throw new Error("Use ensureVideoFile() for YouTube URLs — not ensureVideoFileAnyUrl().");
  }

  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`"${trimmed}" is not a valid http(s) URL.`);
  }

  // uploadsDir() already creates the per-user directory.
  const dir = uploadsDir();
  const slug = mediaSlug(trimmed);

  const cached = findByExt(dir, slug, VIDEO_EXTS);
  if (cached) {
    return { fileUrl: cached, metadata: undefined };
  }

  const metadata: MediaMetadata | null = await probeMetadata(trimmed);
  const { file } = await downloadMedia({ url: trimmed, outDir: dir, outName: slug });
  return { fileUrl: file, metadata: metadata ?? undefined };
}
