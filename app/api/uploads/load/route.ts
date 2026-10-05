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

    const durationSec = await getVideoDurationSec(target);
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