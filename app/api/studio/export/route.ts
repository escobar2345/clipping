import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";
import { ffmpegPath } from "../../../../lib/mediaBins";
import type { StudioTimeline, StudioClip, StudioMedia } from "../../../../lib/studioTypes";

export const runtime = "nodejs";
export const maxDuration = 300;

const W = 1280;
const H = 720;
const FPS = 30;

function studioRoot(): string {
  const dir = path.join(process.cwd(), "data", "studio");
  fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(dir, "exports"), { recursive: true });
  return dir;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function pickFont(): string | null {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Windows\\Fonts\\arial.ttf",
          "C:\\Windows\\Fonts\\segoeui.ttf",
          "C:\\Windows\\Fonts\\tahoma.ttf",
        ]
      : [
          "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
          "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
          "/System/Library/Fonts/Supplemental/Arial.ttf",
        ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function runFfmpeg(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), args, { cwd, windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(err.slice(-4000) || "ffmpeg failed"))
    );
  });
}

// Renders the whole timeline to one mp4 with ffmpeg: correct order, trim in/out,
// speed, volume, burned-in text, fade in/out. Every segment is normalised to
// 1280x720 / 30fps / yuv420p and 48kHz stereo so the concat filter is happy.
// Clips with no audio track get generated silence.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const timeline = body.timeline as StudioTimeline;
    const mediaList = (body.media ?? []) as StudioMedia[];

    if (!timeline?.clips?.length) {
      return NextResponse.json(
        { error: "The timeline is empty — add at least one clip before exporting." },
        { status: 400 }
      );
    }

    const byId = new Map(mediaList.map((m) => [m.mediaId, m]));
    const root = studioRoot();
    const work = path.join(root, "exports", `job-${crypto.randomBytes(4).toString("hex")}`);
    fs.mkdirSync(work, { recursive: true });

    const font = pickFont();
    if (font) {
      try {
        fs.copyFileSync(font, path.join(work, "font.ttf"));
      } catch {
        /* text overlay simply won't render */
      }
    }
    const hasFont = fs.existsSync(path.join(work, "font.ttf"));

    const args: string[] = ["-y", "-hide_banner", "-loglevel", "error"];
    const vLabels: string[] = [];
    const aLabels: string[] = [];
    const filters: string[] = [];
    let inIdx = 0;

    const plan: { clip: StudioClip; vIn: number; aIn: number; d: number; speed: number }[] = [];

    // Pass 1 — one input per clip (plus a silent input when a clip has no audio).
    for (const clip of timeline.clips) {
      const m = byId.get(clip.mediaId);
      if (!m) {
        return NextResponse.json(
          { error: `Unknown media '${clip.mediaId}' — re-import it and try again.` },
          { status: 400 }
        );
      }
      const file = path.join(root, "uploads", m.mediaId);
      if (!fs.existsSync(file)) {
        return NextResponse.json({ error: `Missing file for '${m.name}'.` }, { status: 400 });
      }
      const srcStart = clamp(Number(clip.srcStart) || 0, 0, m.durationSec);
      const srcEnd = clamp(Number(clip.srcEnd) || m.durationSec, srcStart + 0.05, m.durationSec);
      const d = srcEnd - srcStart;
      const speed = clamp(Number(clip.speed) || 1, 0.5, 2);

      const vIn = inIdx++;
      args.push("-ss", srcStart.toFixed(3), "-i", file);
      let aIn = vIn;
      if (!m.hasAudio) {
        aIn = inIdx++;
        args.push("-f", "lavfi", "-t", d.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
      }
      plan.push({ clip, vIn, aIn, d, speed });
    }

    // Pass 2 — each segment's video + audio filter chain.
    for (let i = 0; i < plan.length; i++) {
      const { clip, vIn, aIn, d, speed } = plan[i];
      let vf =
        `[${vIn}:v]fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
        `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,` +
        `trim=duration=${d.toFixed(3)},setpts=(PTS-STARTPTS)/${speed}`;

      const text = (clip.text ?? "").replace(/\r?\n/g, " ").trim().slice(0, 120);
      if (text && hasFont) {
        fs.writeFileSync(path.join(work, `t${i}.txt`), text, "utf8");
        vf +=
          `,drawtext=fontfile=font.ttf:textfile=t${i}.txt:fontsize=42:fontcolor=white` +
          `:borderw=2:bordercolor=black:x=(w-tw)/2:y=h-th-48`;
      }
      if (clip.transition === "fade" || clip.transition === "dissolve") {
        const fd = Math.min(0.5, (d / speed) * 0.1);
        const outStart = Math.max(0, d / speed - fd);
        vf += `,fade=t=in:st=0:d=${fd.toFixed(3)},fade=t=out:st=${outStart.toFixed(3)}:d=${fd.toFixed(3)}`;
      }
      vf += `,format=yuv420p[v${i}]`;
      filters.push(vf);

      const vol = clamp(Number(clip.volume ?? 1), 0, 2);
      filters.push(
        `[${aIn}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `atrim=duration=${d.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${speed},volume=${vol}[a${i}]`
      );
      vLabels.push(`[v${i}]`);
      aLabels.push(`[a${i}]`);
    }

    const n = plan.length;
    filters.push(`${vLabels.join("")}${aLabels.join("")}concat=n=${n}:v=1:a=1[vout][aout]`);

    const outName = `exp-${crypto.randomBytes(6).toString("hex")}.mp4`;
    const outPath = path.join(root, "exports", outName);

    args.push(
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[vout]",
      "-map",
      "[aout]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "160k",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      outPath
    );

    try {
      await runFfmpeg(args, work);
    } catch (e: any) {
      return NextResponse.json(
        { error: "ffmpeg export failed: " + (e?.message ?? "") },
        { status: 500 }
      );
    } finally {
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup of temp text/font files */
      }
    }

    return NextResponse.json({
      url: `/api/studio/file?name=exports/${outName}`,
      downloadUrl: `/api/studio/file?name=exports/${outName}&download=1`,
      name: outName,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "Export failed" }, { status: 500 });
  }
}
