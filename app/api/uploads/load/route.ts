import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { withAuth } from "../../../../lib/withAuth";
import { uploadsDir, uploadsUrlPath } from "../../../../lib/userPaths";
import { getVideoDurationSec } from "../../../../lib/ffmpegFrames";
import { localFileUrl } from "../../../../lib/youtube";
import type { VideoIntel } from "../../../../lib/types";

// Step 01 carry-over: after a page reload your uploaded video is still on disk
// in public/uploads, but the app has no way to reload it without re-uploading
// (which created duplicate up-*.mp4 copies). This route rebuilds the same
// VideoIntel /api/upload returns for an ALREADY-STORED file, so the UI's
// "Load" button can pick it up cleanly — new source file, no copy, no Apify,
// no NVIDIA.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|flv|ts)$/i;
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

export const POST = withAuth(async (req: Request) => {
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

    // Only the signed-in user's own folder is searched.
    const dir = uploadsDir();
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) {
      return NextResponse.json(
        { error: `No stored video named ${file} exists` },
        { status: 404 }
      );
    }

    // yt-dlp's unmerged stream fragment (e.g. `<id>.f399.mp4`) — video-only and
    // audio-less, left behind when ffmpeg wasn't reachable at download time.
    // It ends in .mp4 so the whitelist above passes it; reject it here with
    // the real fix instead of a confusing probe failure.
    if (/\.f\d+\.[^.]+$/.test(file)) {
      return NextResponse.json(
        {
          error:
            `${file} is an unfinished download fragment (video-only, no audio) ` +
            `left when ffmpeg was missing during download. Delete it and re-analyze ` +
            `the URL — with ffmpeg installed the download merges to a playable mp4. ` +
            `(GET /api/health shows whether ffmpeg/ffprobe resolve.)`,
        },
        { status: 400 }
      );
    }

    let durationSec: number;
    try {
      durationSec = await getVideoDurationSec(target);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (/ENOENT/i.test(msg) || /not found/i.test(msg)) {
        return NextResponse.json(
          {
            error:
              `Couldn't probe ${file}: ffmpeg/ffprobe isn't reachable from the app ` +
              `server (spawn ENOENT = the ffprobe *program* is missing, not your ` +
              `video). Restart the dev server after installing ffmpeg, or set ` +
              `FFPROBE_PATH in .env.local. ` +
              `(GET /api/health shows whether ffmpeg/ffprobe resolve.)`,
          },
          { status: 500 }
        );
      }
      throw err;
    }
    if (!durationSec || durationSec < 1) {
      return NextResponse.json(
        { error: `Couldn't read video duration from ${file}` },
        { status: 400 }
      );
    }

    const intel: VideoIntel = {
      sourceUrl: "",
      title: file,
      durationSec,
      videoFilePath: localFileUrl(uploadsUrlPath(file)),
      transcript: [],
    };

    return NextResponse.json({ intel, videoFilePending: false });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Load failed" }, { status: 500 });
  }
});