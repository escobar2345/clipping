import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { withRetry } from "./retry";
import { localFileUrl, remuxIfNeeded } from "./youtube";
import { parseSubtitleText } from "./subtitles";
import type { TranscriptWord } from "./types";

const execFileAsync = promisify(execFile);

/**
 * "Download from anywhere" engine — the real thing apps like BlackHole wrap
 * is yt-dlp, which supports 1000+ sites (TikTok, Instagram, Facebook, X,
 * Vimeo, Reddit, Twitch VODs, direct .mp4 links …). This module drives the
 * locally installed yt-dlp for arbitrary URLs and harvests subtitles for the
 * transcript, so the whole long2short pipeline works beyond YouTube.
 */

export function isYouTubeUrl(url: string): boolean {
  return /(?:^|\.)youtube\.com|youtu\.be/i.test(url);
}

/* ------------------------------------------------------------------ */
/* Box.com shared-file links                                           */
/*                                                                     */
/* Shape: https://<tenant>.box.com/s/<sharedName>[...]/file/<fileId>.  */
/* yt-dlp has no Box extractor (Box serves files behind its own JS     */
/* app + API session flow), so Box is handled natively here: metadata  */
/* via Box's public shared_items API (BoxApi header, no OAuth needed   */
/* for public shares) and downloads via the shared-file download       */
/* endpoint. Shares that are password-protected or restricted to the   */
/* owner's organization 401 on that API — no tool can read them        */
/* without credentials, so we fail with an honest, specific message.   */
/* ------------------------------------------------------------------ */

export function isBoxShareUrl(url: string): boolean {
  return /box\.com\/s\/[A-Za-z0-9]+/i.test(url);
}

function parseBoxShare(
  url: string
): { sharedName: string; fileId?: string; sharedLinkUrl: string } | null {
  const m = url.match(/(https?:\/\/[^/]*box\.com)\/s\/([A-Za-z0-9]+)/i);
  if (!m) return null;
  const f = url.match(/\/file\/(\d+)/i);
  return {
    sharedName: m[2],
    fileId: f?.[1],
    sharedLinkUrl: `${m[1]}/s/${m[2]}`,
  };
}

const BOX_API = "https://api.box.com/2.0";
const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|flv|ts)$/i;

interface BoxItem {
  type: string;
  id: string;
  name: string;
  size?: number;
}

/**
 * Reads a Box shared item via the public shared_items API (no OAuth for
 * public shares). "restricted" = Box answered 401/404, i.e. the share is
 * password-protected or members-only. null = network/shape surprise.
 */
async function boxSharedItem(
  sharedLinkUrl: string
): Promise<BoxItem | "restricted" | null> {
  try {
    const res = await withRetry(
      () =>
        fetch(`${BOX_API}/shared_items`, {
          headers: { BoxApi: `shared_link=${encodeURIComponent(sharedLinkUrl)}` },
        }),
      2
    );
    if (res.status === 401 || res.status === 404) return "restricted";
    if (!res.ok) return null;
    const j: any = await res.json();
    if (!j?.id) return null;
    return {
      type: String(j.type ?? "file"),
      id: String(j.id),
      name: String(j.name ?? "box-file"),
      size: Number(j.size) || undefined,
    };
  } catch {
    return null;
  }
}

/** Public shared-file direct download (no headers needed for public shares). */
function boxDirectDownloadUrl(sharedName: string, fileId: string): string {
  return (
    `https://app.box.com/index.php?rm=box_download_shared_file` +
    `&shared_name=${encodeURIComponent(sharedName)}&file_id=${fileId}`
  );
}

/** The honest, specific error for Box links that require credentials. */
function boxRestrictedError(): Error {
  return new Error(
    "This Box.com share link is not publicly accessible — Box's own API " +
      "reports it as password-protected or restricted to the file owner's " +
      "organization, so no downloader can fetch it without those credentials. " +
      "If you can open it in your browser, download the video there and paste " +
      "the saved file's path (e.g. C:\\Users\\you\\Downloads\\video.mp4) or a " +
      "direct .mp4/.webm link instead. Public Box links (\"anyone with the " +
      "link\" sharing) download automatically."
  );
}

/* ------------------------------------------------------------------ */
/* Box's TEMPORARY signed download links (public.boxcloud.com)          */
/*                                                                      */
/* Shape: https://public.boxcloud.com/d/1/b1!<token>/download. This is  */
/* what Box hands your BROWSER when you click "Download" on a Box file. */
/* The tokens are single-use and expire within minutes, so by the time  */
/* one is pasted here it has usually already been consumed or expired   */
/* (Box answers 400/403). We still try a fresh one, but failures get a  */
/* specific message instead of "unsupported site".                      */
/* ------------------------------------------------------------------ */

export function isBoxCloudUrl(url: string): boolean {
  return /boxcloud\.com/i.test(url);
}

function boxCloudExpiredError(status: number): Error {
  return new Error(
    "This is Box's TEMPORARY signed download link (public.boxcloud.com) — " +
      "those tokens are single-use and expire within minutes" +
      (status ? ` (Box just answered HTTP ${status})` : "") +
      ". Download the video in your browser instead, then paste the saved " +
      "file's path (e.g. C:\\Users\\you\\Downloads\\video.mp4) or the Box " +
      "share page link (…box.com/s/…). Local file paths and public Box " +
      "share links are both supported."
  );
}

/** True when the string is a local file path (Windows drive/UNC or unix
 *  absolute) rather than a URL — lets users paste a downloaded file. */
export function isLocalFilePath(s: string): boolean {
  const t = s.trim().replace(/^["']|["']$/g, "");
  return (
    /^[a-zA-Z]:[\\/]/.test(t) || // C:\ or C:/
    /^\\\\/.test(t) || // UNC \\server\share
    (t.startsWith("/") && !/^https?:\/\//i.test(t)) // /Users/... /home/...
  );
}

/** Strips quotes + normalizes a pasted local path. */
function normalizeLocalPath(s: string): string {
  return path.normalize(s.trim().replace(/^["']|["']$/g, ""));
}

function notVideoFileError(p: string): Error {
  return new Error(
    `"${path.basename(p)}" doesn't look like a video file — paste an ` +
      ".mp4/.mov/.m4v/.webm/.mkv/.avi/.mpg/.ts path."
  );
}

/** Duration of a remote video URL via ffprobe (headers-only read). */
function ffprobeUrlDuration(u: string): number | undefined {
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        u,
      ],
      { windowsHide: true, timeout: 45_000 }
    );
    const d = parseFloat(String(out).trim());
    return Number.isFinite(d) ? Math.round(d) : undefined;
  } catch {
    return undefined;
  }
}

/** Stable, filesystem-safe cache key for any URL. */
function slugFor(url: string): string {
  return "any-" + crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
}

function uploadsDir(): string {
  const dir = path.join(process.cwd(), "public", "uploads");
  // Read-only filesystems (Vercel): don't crash the caller — caption writes
  // simply won't persist there; metadata analysis still works.
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
  return dir;
}

/** Detects a readable browser cookie jar. Firefox wins: its cookies.sqlite is
 *  NOT encrypted and is readable even while Firefox is open. Edge/Chrome DBs
 *  are usually locked while the browser runs (yt-dlp #7271) and recent builds
 *  add app-bound encryption yt-dlp cannot open — so they're skipped. */
function cookieBrowserArgs(): string[] {
  try {
    const ffRoot = path.join(process.env.APPDATA ?? "", "Mozilla", "Firefox", "Profiles");
    if (
      fs.existsSync(ffRoot) &&
      fs.readdirSync(ffRoot).some((p) =>
        fs.existsSync(path.join(ffRoot, p, "cookies.sqlite"))
      )
    ) {
      return ["--cookies-from-browser", "firefox"];
    }
  } catch {
    /* ignore */
  }
  return [];
}

/**
 * Runs yt-dlp with a cookie fallback in BOTH directions: a login-walled site
 * (X, Facebook…) fails anonymously when cookies are available, and a locked
 * or mid-write cookie jar can fail a run that would succeed anonymously.
 * `baseArgs` must NOT contain the url — it is always appended last.
 */
async function ytDlpRun(
  baseArgs: string[],
  url: string,
  timeoutMs: number
): Promise<string> {
  const cookies = cookieBrowserArgs();
  const attempt = (extra: string[]) =>
    execFileAsync(
      "yt-dlp",
      ["--no-playlist", ...extra, ...baseArgs, url],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
    );
  try {
    return (await attempt(cookies)).stdout;
  } catch (err: any) {
    const stderr = String(err?.stderr ?? err?.message ?? "");
    // Diagnose in the server log: was the cookie jar even available, and what
    // did yt-dlp actually say? (probeMetadata callers swallow these errors.)
    console.error(
      `[anywhere] yt-dlp failed (cookies=${cookies.length ? "firefox" : "none"}): ` +
        stderr.slice(-400)
    );
    if (!cookies.length) throw err;
    if (/sign in|log ?in|cookies|age.restricted|private|members/i.test(stderr)) throw err;
    // Cookie jar itself may be the problem — retry anonymously.
    try {
      return (await attempt([])).stdout;
    } catch (err2: any) {
      console.error(
        `[anywhere] yt-dlp anonymous retry also failed: ` +
          String(err2?.stderr ?? err2?.message ?? "").slice(-400)
      );
      throw err2;
    }
  }
}

/** Turns raw yt-dlp stderr into something a human can act on. */
export function humanizeYtDlpError(stderr: string): string {
  const s = stderr.slice(-600);
  if (/no video could be found/i.test(s))
    return "this post contains no video (text-only post).";
  if (/sign in|log ?in to confirm|login|cookies|age.restricted|private video|members/i.test(s))
    return "this link needs a logged-in session — sign in to the site once in Firefox on this PC and try again (the downloader reuses your Firefox cookies automatically).";
  if (/unsupported url/i.test(s))
    return "this site isn't supported. Direct .mp4/.webm links, YouTube, TikTok, Instagram, X, Facebook, Vimeo, Reddit and Twitch work best.";
  if (/http error 4\d\d|404|410/i.test(s))
    return "the site refused this request — the post may be private, deleted or region-locked.";
  return "";
}

/** Local-file duration via ffprobe. Direct-file CDNs (and some platforms)
 *  don't expose duration in metadata — without this, the edit-plan fallback
 *  would assume 600s and cut clip windows past the end of the real video. */
function ffprobeDuration(file: string): number {
  try {
    const out = execFileSync(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        file,
      ],
      { windowsHide: true, timeout: 30_000 }
    );
    const d = parseFloat(String(out).trim());
    return Number.isFinite(d) ? Math.round(d) : 0;
  } catch {
    return 0;
  }
}

/** Quick metadata probe (no download). Fails soft — callers treat as optional.
 *  On failure the raw stderr tail is returned as `errorDetail` so callers can
 *  show the REAL reason (login wall, no video, unsupported site…) instead of
 *  a generic guess. */
export async function probeMetadata(
  url: string
): Promise<{ title?: string; durationSec?: number; errorDetail?: string }> {
  // Box.com shares bypass yt-dlp entirely (no Box extractor exists): read
  // the item through Box's own shared_items API. Errors thrown here are
  // specific (restricted / folder / not-a-video) and propagate to the UI —
  // they must NOT be swallowed into errorDetail below.
  if (isBoxShareUrl(url)) {
    const box = parseBoxShare(url);
    if (!box) {
      throw new Error("That Box.com link isn't a recognizable share link.");
    }
    const item = await boxSharedItem(box.sharedLinkUrl);
    if (item === "restricted") {
      console.error(`[anywhere] box share restricted (401): ${box.sharedLinkUrl}`);
      throw boxRestrictedError();
    }
    if (item) {
      if (item.type !== "file") {
        throw new Error(
          "That Box.com link points to a folder, not a single video file — " +
            "share the video file itself (its own link) and try again."
        );
      }
      if (!VIDEO_EXT.test(item.name)) {
        throw new Error(
          `This Box file ("${item.name}") is not a video — pick an ` +
            `.mp4/.mov/.webm file.`
        );
      }
      const dl = boxDirectDownloadUrl(box.sharedName, item.id);
      return { title: item.name, durationSec: ffprobeUrlDuration(dl) };
    }
    // null → fall through to yt-dlp (best effort) for odd cases
  }

  // Box's temporary signed download links: try it live (a JUST-copied token
  // can still be valid) — a dead one gets the specific expired-token error.
  if (isBoxCloudUrl(url)) {
    try {
      const res = await withRetry(
        () => fetch(url, { headers: { Range: "bytes=0-0" }, redirect: "follow" }),
        1
      );
      if (!res.ok) throw boxCloudExpiredError(res.status);
      return { title: "Box download", durationSec: ffprobeUrlDuration(url) };
    } catch (err: any) {
      if (err instanceof Error && /TEMPORARY signed download link/.test(err.message)) throw err;
      throw boxCloudExpiredError(0);
    }
  }

  // Local file paths (C:\...\video.mp4, /home/.../video.mp4): read straight
  // off the disk — no network, no yt-dlp.
  if (isLocalFilePath(url)) {
    const p = normalizeLocalPath(url);
    if (!fs.existsSync(p)) {
      throw new Error(`File not found: ${p}`);
    }
    if (!VIDEO_EXT.test(p)) throw notVideoFileError(p);
    return { title: path.basename(p), durationSec: ffprobeDuration(p) || undefined };
  }

  try {
    const stdout = await ytDlpRun(["--no-warnings", "--dump-single-json"], url, 90_000);
    const j = JSON.parse(stdout);
    return {
      title: typeof j.title === "string" ? j.title : undefined,
      durationSec: Number.isFinite(j.duration) ? Math.round(j.duration) : undefined,
    };
  } catch (err: any) {
    const stderr = String(err?.stderr ?? err?.message ?? err);
    console.error(`[anywhere] probeMetadata failed for ${url}: ${stderr.slice(-500)}`);
    return { errorDetail: stderr.slice(-600) };
  }
}

/** Finds and parses the subtitle file yt-dlp wrote next to the video. */
function readSubtitles(dir: string, slug: string): TranscriptWord[] {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(slug + ".") && /\.(vtt|srt)$/i.test(f));
  const pick =
    files.find((f) => /^\.?en\b/i.test(f.slice(slug.length))) ?? // slug.en.vtt
    files.find((f) => /en/i.test(f)) ??
    files[0];
  if (!pick) return [];
  try {
    return parseSubtitleText(fs.readFileSync(path.join(dir, pick), "utf8"));
  } catch {
    return [];
  }
}

export interface AnyUrlResult {
  fileUrl: string;
  transcript: TranscriptWord[];
  title?: string;
  durationSec?: number;
}

/**
 * Downloads ANY video URL via yt-dlp (capped at 720p — Remotion outputs
 * 1080x1920 portrait, so 720p source is plenty), remuxes to mp4, and harvests
 * subtitle tracks (auto-subs included) into a word-level transcript.
 *
 * Note: some platforms (Instagram/TikTok) occasionally require cookies or
 * login; when yt-dlp fails the error message tells the user why.
 */
export async function ensureVideoFileAnyUrl(url: string): Promise<AnyUrlResult> {
  const slug = slugFor(url);
  const dir = uploadsDir();
  const finalPath = path.join(dir, `${slug}.mp4`);
  const relPath = `/uploads/${slug}.mp4`;

  if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 100_000) {
    const meta = await probeMetadata(url);
    return {
      fileUrl: localFileUrl(relPath),
      transcript: readSubtitles(dir, slug),
      title: meta.title,
      durationSec:
        meta.durationSec && meta.durationSec > 0
          ? meta.durationSec
          : ffprobeDuration(finalPath),
    };
  }

  // Box's temporary signed download links (public.boxcloud.com/d/1/b1!…):
  // try it live — a JUST-copied token can still work; a dead one gets the
  // specific expired-token error instead of a generic yt-dlp failure.
  if (isBoxCloudUrl(url)) {
    try {
      const res = await withRetry(() => fetch(url, { redirect: "follow" }), 1);
      const ct = String(res.headers.get("content-type") ?? "");
      if (!res.ok || !res.body || /text\/html/i.test(ct)) {
        throw boxCloudExpiredError(res.status);
      }
      const tmp = `${finalPath}.part`;
      await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
      fs.renameSync(tmp, finalPath);
    } catch (err: any) {
      if (err instanceof Error && /TEMPORARY signed download link/.test(err.message)) throw err;
      throw boxCloudExpiredError(0);
    }
    if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size < 100_000) {
      throw boxCloudExpiredError(0);
    }
    return {
      fileUrl: localFileUrl(relPath),
      transcript: [], // signed-link downloads carry no caption sidecars
      title: "Box download",
      durationSec: ffprobeDuration(finalPath),
    };
  }

  // Local file paths (C:\...\video.mp4): copy straight off the disk —
  // no network, no yt-dlp.
  if (isLocalFilePath(url)) {
    const src = normalizeLocalPath(url);
    if (!fs.existsSync(src)) throw new Error(`File not found: ${src}`);
    if (!VIDEO_EXT.test(src)) throw notVideoFileError(src);
    fs.copyFileSync(src, finalPath);
    return {
      fileUrl: localFileUrl(relPath),
      transcript: [],
      title: path.basename(src),
      durationSec: ffprobeDuration(finalPath),
    };
  }

  // Box.com shares: yt-dlp has no Box extractor, so download natively. Public
  // shares stream straight from Box's shared-file endpoint; restricted ones
  // (401 on Box's API — e.g. corporate-tenant shares) fail with an honest
  // message instead of a confusing yt-dlp failure.
  if (isBoxShareUrl(url)) {
    const box = parseBoxShare(url);
    if (!box) {
      throw new Error("That Box.com link isn't a recognizable share link.");
    }
    const item = await boxSharedItem(box.sharedLinkUrl);
    if (item === "restricted") {
      console.error(`[anywhere] box share restricted (401): ${box.sharedLinkUrl}`);
      throw boxRestrictedError();
    }
    if (!item || item.type !== "file") {
      throw new Error(
        "That Box.com link points to a folder or an unreadable item, not a " +
          "single video file — share the video file itself and try again."
      );
    }
    if (!VIDEO_EXT.test(item.name)) {
      throw new Error(
        `This Box file ("${item.name}") is not a video — pick an ` +
          `.mp4/.mov/.webm file.`
      );
    }
    console.error(
      `[anywhere] box: downloading public file ${item.id} ` +
        `(${item.name}${item.size ? `, ${item.size} bytes` : ""})`
    );
    const res = await withRetry(
      () => fetch(boxDirectDownloadUrl(box.sharedName, item.id), { redirect: "follow" }),
      2
    );
    const ct = String(res.headers.get("content-type") ?? "");
    // Box serves an HTML shell (not the file) when the share isn't usable.
    if (!res.ok || !res.body || /text\/html/i.test(ct)) {
      throw boxRestrictedError();
    }
    const tmp = `${finalPath}.part`;
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
    fs.renameSync(tmp, finalPath);
    if (fs.statSync(finalPath).size < 100_000) {
      throw boxRestrictedError();
    }
    return {
      fileUrl: localFileUrl(relPath),
      transcript: [], // Box files carry no caption tracks
      title: item.name,
      durationSec: ffprobeDuration(finalPath),
    };
  }

  // --write-auto-subs + --convert-subs: get caption tracks wherever the site
  // offers them (TikTok/Instagram/Facebook/X auto-captions are common).
  try {
    await ytDlpRun(
      [
        "-f", "bv*[height<=720]+ba/b[height<=720]/b",
        "--merge-output-format", "mp4",
        "--no-part",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", "en.*,en",
        "--sub-format", "vtt/srt/best",
        "--convert-subs", "vtt",
        "-o", path.join(dir, `${slug}.%(ext)s`),
      ],
      url,
      300_000
    );
  } catch (err: any) {
    const raw = String(err?.stderr ?? err?.message ?? err);
    const detail = humanizeYtDlpError(raw) || raw.slice(-300).trim();
    throw new Error(
      `Could not download this URL${detail ? ` — ${detail}` : ""}`
    );
  }

  remuxIfNeeded(dir, slug);
  if (!fs.existsSync(finalPath) || fs.statSync(finalPath).size < 100_000) {
    throw new Error("yt-dlp ran but produced no usable video file for this URL");
  }

  const meta = await probeMetadata(url);
  return {
    fileUrl: localFileUrl(relPath),
    transcript: readSubtitles(dir, slug),
    title: meta.title,
    durationSec:
      meta.durationSec && meta.durationSec > 0
        ? meta.durationSec
        : ffprobeDuration(finalPath),
  };
}

/**
 * Fast, download-free analysis for ANY url: yt-dlp metadata probe + caption
 * track harvest (--skip-download). Runs in seconds, so /api/analyze never
 * stalls on a multi-hundred-MB download — the video FILE is fetched lazily
 * by /api/render right before Remotion needs the pixels.
 */
export async function analyzeAnyUrl(url: string): Promise<{
  title?: string;
  durationSec?: number;
  transcript: TranscriptWord[];
}> {
  const meta = await probeMetadata(url);
  if (!meta.title && !meta.durationSec) {
    // Surface yt-dlp's actual reason (login wall / no video in post /
    // unsupported site / 404) instead of a vague catch-all.
    const reason = meta.errorDetail ? humanizeYtDlpError(meta.errorDetail) : "";
    throw new Error(
      "Could not read this link's metadata" +
        (reason
          ? ` — ${reason}`
          : " — it may be private, region-locked, text-only, or from an " +
            "unsupported site. If it's from X or Facebook, sign in to the site " +
            "once in Firefox on this PC and retry (your Firefox session is " +
            "reused automatically). Direct .mp4/.webm links and " +
            "TikTok/Instagram/YouTube work without any login.")
    );
  }
  const slug = slugFor(url);
  const dir = uploadsDir();
  let transcript: TranscriptWord[] = [];
  try {
    await ytDlpRun(
      [
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs", "en.*,en",
        "--sub-format", "vtt/srt/best",
        "--convert-subs", "vtt",
        "-o", path.join(dir, `${slug}.%(ext)s`),
      ],
      url,
      120_000
    );
    transcript = readSubtitles(dir, slug);
  } catch {
    // captions are best-effort; metadata is the critical part
  }
  return { title: meta.title, durationSec: meta.durationSec, transcript };
}