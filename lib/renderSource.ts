import fs from "fs";
import path from "path";
import { ensureVideoFileAnyUrl, isYouTubeUrl } from "./anywhere";
import { videoUrlToLocalPath } from "./visualScan";
import { ensureVideoFile, uploadPathToUrl } from "./youtube";

/**
 * Resolves a plan's source into a URL Remotion can fetch from the running app.
 * Old plans may contain a localhost /uploads URL whose file disappeared after
 * a deploy/restart; URL sources are re-cached, while lost user uploads fail with
 * a useful message instead of Remotion's opaque HTML 404.
 */
export async function resolveRenderSourceVideo(
  sourceVideoPath: string | undefined,
  sourceUrl: string | undefined
): Promise<string> {
  const candidate = sourceVideoPath?.trim() ?? "";

  if (candidate) {
    let url: URL | null = null;
    try {
      url = new URL(candidate);
    } catch {
      // Absolute on-disk paths are also accepted from older edit plans.
    }

    const isLoopbackUrl =
      url !== null && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
    if (url && !isLoopbackUrl) {
      // Preserve user-supplied remote media URLs; only local app files need
      // the filesystem check and the dynamic media-serving endpoint.
      return candidate;
    }

    const localPath = url ? videoUrlToLocalPath(candidate) : candidate;
    if (localPath && fs.existsSync(localPath)) {
      const uploadsRoot = `${path.resolve(process.cwd(), "public", "uploads")}${path.sep}`;
      const resolvedPath = path.resolve(localPath);
      if (resolvedPath.startsWith(uploadsRoot)) {
        return uploadPathToUrl(resolvedPath);
      }
      return candidate;
    }

    const isOldUploadsUrl = Boolean(url && isLoopbackUrl && url.pathname.startsWith("/uploads/"));
    if (!isOldUploadsUrl && !path.isAbsolute(candidate)) {
      return candidate;
    }
  }

  const recoverUrl = sourceUrl?.trim();
  if (!recoverUrl) {
    throw new Error(
      "The source video is no longer on this server. Re-upload the video, or " +
        "re-analyze its URL before rendering."
    );
  }

  if (isYouTubeUrl(recoverUrl)) {
    return uploadPathToUrl(await ensureVideoFile(recoverUrl));
  }

  return (await ensureVideoFileAnyUrl(recoverUrl)).fileUrl;
}