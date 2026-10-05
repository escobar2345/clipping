import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import os from "os";
import type { VideoIntel } from "../../../lib/types";
import { withAuth } from "../../../lib/withAuth";
import { extractStyleProfileVision } from "../../../lib/nvidiaGlm";
import { getVideoDurationSec } from "../../../lib/ffmpegFrames";

// This route no longer touches Apify. Step 02 (reference editing style) now
// takes a directly-uploaded video file: we save it to a temp file, read its
// duration with ffprobe, extract frames with ffmpeg, and infer the style with
// the NVIDIA vision model. No transcript, no Apify actor run, no cost here.
// (Step 01 / /api/analyze still uses Apify for the source video — untouched.)
export const runtime = "nodejs";

export const POST = withAuth(async (req: Request) => {
  let tmpDir: string | null = null;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json(
        { error: "A video file upload ('file') is required" },
        { status: 400 }
      );
    }

    // Persist the upload so ffmpeg/ffprobe (which take a path) can read it.
    const upload = file as File;
    const arrayBuf = await upload.arrayBuffer();
    const ext = path.extname(upload.name || "") || ".mp4";
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "styleref-"));
    const tmpPath = path.join(tmpDir, `sample${ext}`);
    await fs.writeFile(tmpPath, Buffer.from(arrayBuf));

    const durationSec = await getVideoDurationSec(tmpPath);

    // Minimal VideoIntel: extractStyleProfileVision only reads videoFilePath +
    // durationSec, so the transcript/sourceUrl fields stay empty here.
    const sampleIntel: VideoIntel = {
      sourceUrl: "",
      title: upload.name || "reference",
      durationSec,
      videoFilePath: tmpPath,
      transcript: [],
    };

    const styleProfile = await extractStyleProfileVision(sampleIntel);
    return NextResponse.json({ styleProfile });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message ?? "Style extraction failed" },
      { status: 500 }
    );
  } finally {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
});
