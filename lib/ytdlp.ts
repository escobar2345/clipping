import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { resolveMediaBin } from "./mediaBins";

/**
 * yt-dlp wrapper — SERVER-SIDE ONLY.
 *
 * Turns a video URL (YouTube, TikTok, Instagram, Vimeo, ...) into a local video
 * file Remotion's <OffthreadVideo> can read, plus a metadata probe and the
 * platform's caption track.
 *
 * Requires the `yt-dlp` binary on PATH. Override the location with
 * YTDLP_PATH=/full/path/to/yt-dlp(.exe) when it isn't on PATH.
 *
 *   YTDLP_PATH       optional, explicit path to the yt-dlp binary
 *   YTDLP_FORMAT     optional, override the video format selector
 */

const execFileAsync = promisify(execFile);

const DEFAULT_FORMAT =
  "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b[height<=1080]/b";

const VIDEO_EXTS = [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"];
const SUBTITLE_EXTS = [".vtt", ".srt", ".json3", ".srv3", ".ttml"];

const MISSING_BIN_HINT =
  "yt-dlp is not installed or not on PATH. Run `npm run install:ytdlp` to fetch " +
  "the standalone binary into vendor/bin/ (this also runs automatically during " +
  "`npm install`/`npm ci`), or install it with \"pip install -U yt-dlp\" (or " +
  "download yt-dlp.exe from https://github.com/yt-dlp/yt-dlp#installation), then " +
  "restart the dev server. If it lives somewhere unusual, set YTDLP_PATH in " +
  ".env.local to the full path of the binary.";

/**
 * Optional flags applied to EVERY yt-dlp invocation, driven by env so Railway
 * can be reconfigured without code changes:
 *
 *   --plugin-dirs  points the (standalone) binary at the bgutil PO-token plugin
 *                  vendored by scripts/install-pot-provider.mjs, so YouTube's
 *                  "Sign in to confirm you're not a bot" checks on flagged IPs
 *                  get proof-of-origin tokens from the local server (port 4416).
 *   --js-runtimes  yt-dlp enables ONLY deno as a JS runtime by default; with
 *                  none found, the n-challenge solver fails and formats are
 *                  dropped. We always run under node, so hand yt-dlp the exact
 *                  runtime we're using (verified to restore full format lists).
 *   --extractor-args  YouTube player clients that work with the PO-token flow.
 *                  The default web client dies with HTTP 429/bot-check before a
 *                  token is even requested; mweb succeeds (bgutil README's
 *                  documented workaround). Override via YTDLP_YT_CLIENTS, or set
 *                  it to "" to disable.
 *   --cookies      YTDLP_COOKIES (Netscape cookies.txt CONTENTS, written to
 *                  data/yt-cookies.txt) or YTDLP_COOKIES_FILE (path). The
 *                  documented fix for datacenter-IP bot checks (bgutil README).
 *   --proxy        YTDLP_PROXY, e.g. a residential proxy URL.
 */
export function ytDlpGlobalArgs(): string[] {
  const args: string[] = [];

  // --ffmpeg-location: yt-dlp finds ffmpeg ONLY via its own PATH lookup, and
  // without it the video+audio merge silently degrades to an audio-less
  // `<id>.fNNN.mp4` stream fragment. Point it at our multi-location resolver
  // (PATH / nix store / winget / env) instead of trusting yt-dlp's guess.
  const ffmpeg = resolveMediaBin("ffmpeg");
  if (ffmpeg) args.push("--ffmpeg-location", ffmpeg);

  // --plugin-dirs X iterates X's *children*, and each child must itself contain
  // a `yt_dlp_plugins/` package — so X is the bgutil repo root (whose child
  // `plugin/` holds the package). Passing `plugin/` itself yields "PO Token
  // Providers: none" (verified against yt-dlp 2026.08.19).
  const potRoot = path.join(process.cwd(), "vendor", "bgutil-ytdlp-pot-provider");
  if (fs.existsSync(path.join(potRoot, "plugin", "yt_dlp_plugins"))) {
    args.push("--plugin-dirs", potRoot);
  }

  // Point the n-challenge solver at the node we ourselves run under.
  const execPath = process.execPath || "";
  if (/node(\.exe)?$/i.test(path.basename(execPath))) {
    args.push("--js-runtimes", `node:${execPath}`);
  }

  // Player clients for the PO-token flow (see doc comment). Env-gated.
  const clients = (process.env.YTDLP_YT_CLIENTS ?? "mweb,tv,web_safari").trim();
  if (clients) args.push("--extractor-args", `youtube:player-client=${clients}`);

  const cookies = cookiesFile();
  if (cookies) args.push("--cookies", cookies);

  const proxy = (process.env.YTDLP_PROXY ?? "").trim();
  if (proxy) args.push("--proxy", proxy);

  return args;
}

/** Resolves the cookies file to pass yt-dlp, writing YTDLP_COOKIES contents out. Null = none. */
function cookiesFile(): string | null {
  const fileVar = (process.env.YTDLP_COOKIES_FILE ?? "").trim();
  if (fileVar) {
    if (fs.existsSync(fileVar)) return fileVar;
    console.warn(`[ytdlp] YTDLP_COOKIES_FILE points at a missing file: ${fileVar}`);
    return null;
  }
  const inline = (process.env.YTDLP_COOKIES ?? "").trim();
  if (!inline) return null;
  const target = path.join(process.cwd(), "data", "yt-cookies.txt");
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Normalize pasted CRLF; Netscape format wants one \n-terminated row per cookie.
    fs.writeFileSync(target, inline.replace(/\r\n/g, "\n") + "\n", { mode: 0o600 });
    return target;
  } catch (err) {
    console.warn(`[ytdlp] could not write cookies file: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * When yt-dlp fails with YouTube's datacenter-IP bot check, append the fix
 * instead of leaving the user staring at YouTube's wall of links.
 * Pure function — exported for tests.
 */
export function botCheckAdvice(reason: string): string | null {
  if (!/not a bot|sign in to confirm/i.test(reason)) return null;
  return (
    "YouTube flagged this server's IP address (normal for datacenter/cloud IPs). " +
    "Fix: export youtube.com cookies while logged into your account — e.g. the " +
    "'Get cookies.txt LOCALLY' browser extension → cookies.txt — and set the " +
    "YTDLP_COOKIES env var in Railway to the FULL CONTENTS of that file, then " +
    "redeploy. Alternative: set YTDLP_PROXY to a residential proxy. The built-in " +
    "PO-token server (installed on npm ci, see npm run install:pot) mitigates " +
    "this automatically, but cookies are the guaranteed fix on cloud IPs."
  );
}

interface Runner {
  cmd: string;
  baseArgs: string[];
}

let cachedRunner: Runner | null = null;

/** Candidate ways to invoke yt-dlp, tried in order. */
function candidates(): Runner[] {
  const list: Runner[] = [];
  const explicit = (process.env.YTDLP_PATH ?? "").trim();
  if (explicit) list.push({ cmd: explicit, baseArgs: [] });
  // Binary vendored by scripts/install-ytdlp.mjs (postinstall). Preferred over
  // PATH lookups: on Railway no system yt-dlp/python exists, so this is what
  // makes renders work in the container.
  const vendored = path.join(
    process.cwd(),
    "vendor",
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
  );
  if (fs.existsSync(vendored)) list.push({ cmd: vendored, baseArgs: [] });
  // On Windows the extensionless name can fail execFile, so try .exe first.
  list.push({ cmd: "yt-dlp.exe", baseArgs: [] }, { cmd: "yt-dlp", baseArgs: [] });
  // Fall back to the Python module — works when the console script isn't on PATH.
  for (const py of ["python", "python3", "py"]) {
    list.push({ cmd: py, baseArgs: ["-m", "yt_dlp"] });
  }
  return list;
}

/** Finds a working yt-dlp invocation, caching it for the process lifetime. */
async function runner(): Promise<Runner> {
  if (cachedRunner) return cachedRunner;
  let lastErr: unknown;
  for (const cand of candidates()) {
    try {
      await execFileAsync(cand.cmd, [...cand.baseArgs, "--version"], {
        timeout: 30_000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      cachedRunner = cand;
      return cand;
    } catch (err) {
      lastErr = err;
    }
  }
  const detail = lastErr instanceof Error ? lastErr.message : String(lastErr ?? "");
  throw new Error(`${MISSING_BIN_HINT} (last attempt: ${detail})`);
}

/** Runs yt-dlp with the given args and returns stdout. */
export async function runYtdlp(args: string[], timeoutMs = 20 * 60_000): Promise<string> {
  const r = await runner();
  try {
    const { stdout } = await execFileAsync(
      r.cmd,
      [...r.baseArgs, ...ytDlpGlobalArgs(), ...args],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      }
    );
    return stdout;
  } catch (err: any) {
    // yt-dlp writes the real reason (geo-block, private video, 404, DRM) to
    // stderr — surface that instead of execFile's generic "Command failed".
    const stderr = String(err?.stderr ?? "").trim();
    const reason = stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" ").trim();
    const base = reason || `yt-dlp failed: ${err?.message ?? "unknown error"}`;
    const advice = botCheckAdvice(base);
    throw new Error(advice ? `${base}\n\n→ ${advice}` : base);
  }
}

/** yt-dlp availability + version, for diagnostics. Null when not usable. */
export async function ytdlpVersion(): Promise<string | null> {
  try {
    const r = await runner();
    const { stdout } = await execFileAsync(r.cmd, [...r.baseArgs, "--version"], {
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim().split(/\r?\n/)[0] ?? null;
  } catch {
    return null;
  }
}
export interface MediaMetadata {
  id?: string;
  title?: string;
  duration?: number;
  uploader?: string;
  [key: string]: any;
}

/**
 * Reads a URL's metadata without downloading the video.
 * Returns null when the URL can't be probed, so callers can fall back.
 */
export async function probeMetadata(url: string, timeoutMs = 120_000): Promise<MediaMetadata | null> {
  try {
    const stdout = await runYtdlp(
      ["--dump-single-json", "--skip-download", "--no-playlist", "--no-warnings", url],
      timeoutMs
    );
    const json = JSON.parse(stdout.trim());
    return json && typeof json === "object" ? (json as MediaMetadata) : null;
  } catch {
    return null;
  }
}

/**
 * Fetches the platform's caption track ONLY (no video) into
 * `<outDir>/<outName>.<ext>`. Returns the caption file path, or null when the
 * video has no captions / the platform refused them. Never throws.
 *
 * This is the cheap way to get real word timings at analyze time — the video
 * itself stays lazy and is only pulled at render time.
 */
export async function downloadSubtitles(opts: {
  url: string;
  outDir: string;
  outName: string;
  timeoutMs?: number;
}): Promise<string | null> {
  const { url, outDir, outName, timeoutMs = 5 * 60_000 } = opts;
  fs.mkdirSync(outDir, { recursive: true });
  const subLangs = (process.env.YTDLP_SUB_LANGS ?? "").trim() || "en";

  try {
    await runYtdlp(
      [
        "--skip-download",
        "--write-subs",
        "--write-auto-subs",
        "--sub-langs",
        subLangs,
        "--sub-format",
        "vtt/srt/best",
        "--no-playlist",
        "--no-warnings",
        "-o",
        path.join(outDir, `${outName}.%(ext)s`),
        url,
      ],
      timeoutMs
    );
  } catch {
    // Deliberately swallowed: yt-dlp exits non-zero when ANY requested track
    // fails (a translated track rate-limited with HTTP 429, say) even though it
    // already wrote the English one we actually want. Judge success by what's
    // on disk, not by the exit code.
  }

  // Prefer a plain `en` track, then any English variant, then whatever landed.
  const found = fs.readdirSync(outDir).filter((e) => {
    if (!e.startsWith(outName) || e.endsWith(".part") || e.endsWith(".ytdl")) return false;
    return SUBTITLE_EXTS.includes(path.extname(e).toLowerCase());
  });
  if (found.length === 0) return null;

  const exact = found.find((e) => /\.en\.(vtt|srt|json3|srv3|ttml)$/i.test(e));
  return path.join(outDir, exact ?? found[0]);
}

export interface DownloadResult {
  /** The downloaded video's real path on disk. */
  file: string;
  /** The platform's caption file when one was fetched, else null. */
  subtitleFile: string | null;
}

/**
 * Downloads the video to `<outDir>/<outName>.<ext>` and returns the real path
 * (yt-dlp picks the container, so the extension isn't guaranteed to be .mp4).
 *
 * Caption tracks come from a SEPARATE, best-effort call so a video with no
 * subtitles still downloads.
 */
export async function downloadMedia(opts: {
  url: string;
  outDir: string;
  outName: string;
  timeoutMs?: number;
}): Promise<DownloadResult> {
  const { url, outDir, outName, timeoutMs = 20 * 60_000 } = opts;
  fs.mkdirSync(outDir, { recursive: true });

  const base = path.join(outDir, outName);
  const format = (process.env.YTDLP_FORMAT ?? "").trim() || DEFAULT_FORMAT;

  // 1) Captions first — optional, never fatal.
  const subtitleFile = await downloadSubtitles({ url, outDir, outName, timeoutMs: 5 * 60_000 });

  // 2) The video itself — fatal if this fails.
  await runYtdlp(
    [
      "--no-playlist",
      "--no-progress",
      "--no-warnings",
      "-f",
      format,
      "--merge-output-format",
      "mp4",
      "-o",
      `${base}.%(ext)s`,
      url,
    ],
    timeoutMs
  );

  const file = findByExt(outDir, outName, VIDEO_EXTS);
  if (!file) {
    throw new Error(
      `yt-dlp reported success but no video file appeared in ${outDir}. ` +
        (resolveMediaBin("ffmpeg")
          ? `Check the dev-server log for the yt-dlp output.`
          : `ffmpeg could not be resolved either (set FFMPEG_PATH or add ffmpeg to ` +
            `PATH) — without it yt-dlp cannot merge video+audio streams. Also check ` +
            `the dev-server log.`)
    );
  }
  return { file, subtitleFile };
}

/**
 * Largest file written for this outName with one of the given extensions.
 * yt-dlp can leave .part/.ytdl temporaries behind, and splits video+audio
 * before merging, so prefer the biggest complete file.
 */
function findByExt(outDir: string, outName: string, exts: string[]): string | null {
  let best: { path: string; size: number } | null = null;
  for (const entry of fs.readdirSync(outDir)) {
    if (!entry.startsWith(outName)) continue;
    if (entry.endsWith(".part") || entry.endsWith(".ytdl")) continue;
    // Unmerged stream fragment (`outName.f399.mp4`) — never the real result.
    if (/\.f\d+\.[^.]+$/.test(entry)) continue;
    if (!exts.includes(path.extname(entry).toLowerCase())) continue;
    const full = path.join(outDir, entry);
    const size = safeSize(full);
    if (!best || size > best.size) best = { path: full, size };
  }
  return best?.path ?? null;
}

function safeSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}