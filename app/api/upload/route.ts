import { NextResponse } from "next/server";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { withAuth } from "../../../lib/withAuth";
import { uploadsDir, uploadsUrlPath } from "../../../lib/userPaths";
import { getVideoDurationSec } from "../../../lib/ffmpegFrames";
import { localFileUrl, remuxIfNeeded } from "../../../lib/youtube";
import { recordAnalyzeEvent } from "../../../lib/billing";
import type { VideoIntel } from "../../../lib/types";

// Step 01 alternative to /api/analyze: instead of pasting a URL, the user can
// upload a video file straight from their computer. We stream it into
// public/uploads (the same cache folder URL-downloads land in), remux
// anything that isn't mp4 into mp4, read the duration with ffprobe, and hand
// back the exact same VideoIntel shape /api/analyze returns — so edit-plan,
// render and posting work unchanged. Uploaded files carry no transcript, so
// the edit planner automatically falls back to its visual (scene-cut) mode.
export const runtime = "nodejs";
export const maxDuration = 300;

// Same whitelist as lib/anywhere.ts — if it can't be fed to ffmpeg, reject it.
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|flv|ts)$/i;

export const POST = withAuth(
  async (req: Request) => {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json(
        { error: "A video file upload ('file') is required" },
        { status: 400 }
      );
    }

    const upload = file as File;
    const originalName = (upload.name || "upload.mp4").trim();
    if (!VIDEO_EXT.test(originalName)) {
      return NextResponse.json(
        {
          error:
            `"${originalName}" doesn't look like a video file — pick an ` +
            ".mp4/.mov/.m4v/.webm/.mkv/.avi/.mpg/.flv/.ts file.",
        },
        { status: 400 }
      );
    }

    const ext = path.extname(originalName).toLowerCase();
    const id = `up-${crypto.randomBytes(6).toString("hex")}`;
    // Per-user destination: this file lands in public/uploads/<userId>/ and is
    // never visible to another account.
    const upDir = uploadsDir();
    const rawPath = path.join(upDir, `${id}${ext}`);

    // Stream straight to disk — uploads can be hundreds of MB and buffering
    // them fully in RAM is how servers get OOM-killed.
    const streamFn = (upload as File & { stream?: () => ReadableStream<Uint8Array> })
      .stream;
    if (typeof streamFn === "function") {
      await pipeline(
        Readable.fromWeb(streamFn.call(upload) as any),
        fs.createWriteStream(rawPath)
      );
    } else {
      // Ancient runtime without File.stream — fall back to a single buffer.
      await fs.promises.writeFile(rawPath, Buffer.from(await upload.arrayBuffer()));
    }

    if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size < 100_000) {
      fs.rmSync(rawPath, { force: true });
      return NextResponse.json(
        {
          error:
            "The uploaded file is smaller than a real video — nothing usable " +
            "reached the server. Try again.",
        },
        { status: 400 }
      );
    }

    // Normalize the container: webm/mkv/mov → mp4 (stream copy, no re-encode).
    // If the copy isn't mp4-compatible, remuxIfNeeded fails gracefully and we
    // just keep the original container — ffmpeg reads it fine at render time.
    remuxIfNeeded(upDir, id);
    const finalName = fs.existsSync(path.join(upDir, `${id}.mp4`))
      ? `${id}.mp4`
      : `${id}${ext}`;
    const finalPath = path.join(upDir, finalName);
    if (finalName !== `${id}${ext}`) {
      fs.rmSync(rawPath, { force: true });
    }

    // ffprobe doubles as the "is this actually a decodable video" check.
    let durationSec = 0;
    try {
      durationSec = await getVideoDurationSec(finalPath);
    } catch {
      return NextResponse.json(
        {
          error:
            "Couldn't read the uploaded video (ffprobe failed). Is ffmpeg/ffprobe " +
            "installed and on PATH, and is the file a playable video?",
        },
        { status: 400 }
      );
    }
    if (!durationSec || durationSec < 1) {
      fs.rmSync(finalPath, { force: true });
      return NextResponse.json(
        { error: "ffprobe couldn't find any playable video track in this file." },
        { status: 400 }
      );
    }

    const intel: VideoIntel = {
      // No source URL exists for a local upload; downstream code treats ""
      // as "no lazy download needed" (the file is already on disk).
      sourceUrl: "",
      title: originalName,
      durationSec,
      videoFilePath: localFileUrl(uploadsUrlPath(finalName)),
      transcript: [],
    };

    // Count it against this month's quota. Never throws — usage tracking must
    // not be able to fail a user's actual work.
    await recordAnalyzeEvent();

    return NextResponse.json({
      intel,
      // The video FILE is already saved server-side — render needs no download.
      videoFilePending: false,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Upload failed" },
      { status: 500 }
    );
  }
  },
  // Counts against the monthly video allowance; 402 when it's used up.
  { metered: "analyze" }
);
