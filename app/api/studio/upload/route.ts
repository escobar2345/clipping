import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { ffprobePath } from "../../../../lib/mediaBins";
import type { StudioMedia } from "../../../../lib/studioTypes";

export const runtime = "nodejs";
export const maxDuration = 120;

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|flv|ts)$/i;

function studioRoot(): string {
  const dir = path.join(process.cwd(), "data", "studio");
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  return dir;
}

function probe(
  file: string
): Promise<{ durationSec: number; width: number; height: number; hasAudio: boolean }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      file,
    ];
    const p = spawn(ffprobePath(), args, { windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(err || "ffprobe failed"));
      try {
        const j = JSON.parse(out);
        const streams: any[] = j.streams ?? [];
        const v = streams.find((s) => s.codec_type === "video");
        const a = streams.find((s) => s.codec_type === "audio");
        const durationSec = Number(j.format?.duration ?? v?.duration ?? 0);
        resolve({
          durationSec,
          width: Number(v?.width ?? 0),
          height: Number(v?.height ?? 0),
          hasAudio: !!a,
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "A video file ('file') is required" }, { status: 400 });
    }
    const f = file as File;
    const original = (f.name || "video.mp4").trim();
    if (!VIDEO_EXT.test(original)) {
      return NextResponse.json(
        { error: `"${original}" isn't a supported video (.mp4/.mov/.webm/.mkv/…)` },
        { status: 400 }
      );
    }

    const root = studioRoot();
    const ext = path.extname(original).toLowerCase() || ".mp4";
    const mediaId = `st-${crypto.randomBytes(6).toString("hex")}${ext}`;
    const dest = path.join(root, "uploads", mediaId);

    const buf = Buffer.from(await f.arrayBuffer());
    await fs.promises.writeFile(dest, buf);

    let info: { durationSec: number; width: number; height: number; hasAudio: boolean };
    try {
      info = await probe(dest);
    } catch (e: any) {
      fs.rmSync(dest, { force: true });
      return NextResponse.json(
        { error: "Couldn't read the video (ffprobe failed): " + (e?.message ?? "") },
        { status: 400 }
      );
    }
    if (!info.durationSec || info.durationSec <= 0) {
      fs.rmSync(dest, { force: true });
      return NextResponse.json(
        { error: "ffprobe couldn't find any playable video track in this file." },
        { status: 400 }
      );
    }

    const media: StudioMedia = {
      mediaId,
      name: original,
      durationSec: info.durationSec,
      width: info.width,
      height: info.height,
      hasAudio: info.hasAudio,
    };
    return NextResponse.json({ media });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Upload failed" }, { status: 500 });
  }
}
