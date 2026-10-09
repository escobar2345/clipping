// Story teaser cutter: 7-15s vertical teaser from a rendered clip.
// Uses ffmpeg stream-copy trim (fast, no re-encode) so the teaser is ready
// to post to IG/TikTok/YT Stories the same day as the feed post.
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";
import { ffmpegPath } from "./mediaBins";
const execAsync = promisify(execFile);

export async function cutStoryTeaser(renderedRelPath: string, teaserSec = 15): Promise<string> {
  const clean = String(renderedRelPath || "").replace(/\\/g, "/");
  if (!clean.startsWith("/renders/")) throw new Error("renderedPath must be a /renders/... path");
  const src = path.join(process.cwd(), "public", clean.replace(/^\/+/, ""));
  if (!fs.existsSync(src)) throw new Error("Rendered file not found: " + clean);
  const base = path.basename(clean, ".mp4");
  const outFile = `${base}-story.mp4`;
  const outAbs = path.join(process.cwd(), "public", "renders", outFile);
  if (!fs.existsSync(outAbs)) {
    await execAsync(ffmpegPath(), ["-y", "-i", src, "-t", String(teaserSec), "-c", "copy", outAbs], { timeout: 120000 } as any);
  }
  return `/renders/${outFile}`;
}
