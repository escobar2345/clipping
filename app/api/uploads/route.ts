import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { withAuth } from "../../../lib/withAuth";
import { uploadsDir, uploadsUrlPath } from "../../../lib/userPaths";

export const runtime = "nodejs";
// The uploads dir changes with every download/upload/delete — never cache.
export const dynamic = "force-dynamic";

// Same video whitelist as /api/upload — only ever touch real media files.
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|flv|ts)$/i;
// Bare filenames only — blocks path traversal like "../../.env.local".
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

/**
 * Lists the source videos THIS user has stored (public/uploads/<userId/>): URL
 * downloads (yt-<id>.mp4 / any-<slug>.mp4) AND files they uploaded directly
 * (/api/upload, up-<slug>.mp4). Read-only listing.
 *
 * Scoped by the signed-in user — one account never sees another's media.
 */
export const GET = withAuth(async () => {
  let uploads: Record<string, any>[] = [];
  try {
    const dir = uploadsDir();
    uploads = fs
      .readdirSync(dir)
      .filter((f) => VIDEO_EXT.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return {
          file: f,
          url: uploadsUrlPath(f),
          sizeMb: +(st.size / 1024 / 1024).toFixed(1),
          modified: st.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    /* no uploads dir yet — nothing stored */
  }
  return NextResponse.json({ uploads });
});

/**
 * Deletes ONE stored source video (and any subtitle sidecars yt-dlp saved
 * next to it). This never touches Buffer — source videos are only inputs for
 * rendering new clips; posts already queued in Buffer carry their own media
 * URL. Body: { file: "up-1a2b3c4d5e6f.mp4" }
 */
export const DELETE = withAuth(async (req: Request) => {
  try {
    const { file } = (await req.json()) as { file?: string };
    if (
      !file ||
      file !== path.basename(file) ||
      !SAFE_FILENAME.test(file) ||
      !VIDEO_EXT.test(file)
    ) {
      return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
    }

    // uploadsDir() is the SIGNED-IN user's folder, so this can only ever
    // delete that user's own file.
    const dir = uploadsDir();
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) {
      return NextResponse.json(
        { error: `No stored video named ${file} exists` },
        { status: 404 }
      );
    }
    fs.unlinkSync(target);

    // Best-effort cleanup of caption sidecars saved alongside URL downloads
    // (e.g. any-<slug>.en.vtt). The slug prefix is unique, so matching on it
    // can't hit unrelated files.
    const base = file.replace(/\.[^.]+$/, "");
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(`${base}.`)) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch {
          /* sidecar cleanup is best-effort */
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Delete failed" }, { status: 500 });
  }
});
