import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * ffmpeg / ffprobe resolution that survives hosts where the binaries exist but
 * aren't reachable from the SERVER process's PATH.
 *
 * Symptoms without this: `spawn ffprobe ENOENT` from Step 01's Load button
 * (duration read), scene-detect/remux failures, and yt-dlp silently leaving
 * audio-less `<id>.f399.mp4` fragments behind because it couldn't merge
 * video+audio streams.
 *
 * Resolution order — first candidate that actually runs `<bin> -version` wins:
 *   1. FFMPEG_PATH / FFPROBE_PATH env override (full path to the binary)
 *   2. PATH (quote-wrapped entries tolerated)
 *   3. Known install locations — nix profiles + /nix/store (Railway),
 *      winget / scoop / chocolatey (Windows), Homebrew / MacPorts / /usr (else).
 *
 * Only successful resolutions are memoized, so fixing the env/PATH takes effect
 * without a restart on the next spawn.
 */
export type MediaBin = "ffmpeg" | "ffprobe";

const cache = new Map<MediaBin, string>();

/** Test hook — drop memoized resolutions. */
export function clearMediaBinCache(): void {
  cache.clear();
}

/** Absolute path to the binary, or null when it can't be found anywhere. */
export function resolveMediaBin(bin: MediaBin): string | null {
  const memo = cache.get(bin);
  if (memo) return memo;
  const found = findBin(bin);
  if (found) cache.set(bin, found);
  return found;
}

/** Absolute path to ffmpeg; throws an actionable error when truly missing. */
export function ffmpegPath(): string {
  return requireBin("ffmpeg");
}

/** Absolute path to ffprobe; throws an actionable error when truly missing. */
export function ffprobePath(): string {
  return requireBin("ffprobe");
}

function requireBin(bin: MediaBin): string {
  const found = resolveMediaBin(bin);
  if (found) return found;
  const envKey = bin === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  throw new Error(
    `${bin} not found. Fix: set ${envKey}=<full path to ${bin}` +
      `${process.platform === "win32" ? ".exe" : ""}> in .env.local, add ffmpeg ` +
      `to the machine's PATH, or (Railway) keep "ffmpeg" in nixpacks.toml's ` +
      `nixPkgs and redeploy. Searched: ${envKey}, PATH, nix profiles + /nix/store, ` +
      `winget/scoop/chocolatey, /usr/bin, /usr/local/bin, Homebrew, MacPorts.`
  );
}

function findBin(bin: MediaBin): string | null {
  const exe = process.platform === "win32" ? `${bin}.exe` : bin;

  // 1) Explicit override — skipped when it doesn't run (a stale path is worse
  //    than falling through to PATH).
  const envKey = bin === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  const fromEnv = (process.env[envKey] ?? "").trim();
  if (fromEnv && runs(fromEnv)) return fromEnv;

  // 2) PATH.
  const sep = process.platform === "win32" ? ";" : ":";
  for (const raw of (process.env.PATH ?? "").split(sep)) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (runs(candidate)) return candidate;
  }

  // 3) Known locations.
  for (const candidate of knownLocations(exe)) {
    if (runs(candidate)) return candidate;
  }
  return null;
}
/** The only honest existence check: the binary must run `-version`. */
function runs(candidate: string): boolean {
  try {
    execFileSync(candidate, ["-version"], {
      stdio: "ignore",
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function knownLocations(exe: string): string[] {
  const out: string[] = [];
  const home = os.homedir();

  // Nix (Railway images and nix users): profile bins first (cheap), then the
  // store itself — this survives a container whose PATH was overridden.
  for (const dir of [
    "/nix/var/nix/profiles/default/bin",
    path.join(home, ".nix-profile", "bin"),
    "/run/current-system/sw/bin",
  ]) {
    out.push(path.join(dir, exe));
  }
  out.push(...nixStoreBins(exe));

  if (process.platform === "win32") {
    // winget: %LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin\
    out.push(
      ...glob(
        path.join(
          process.env.LOCALAPPDATA ?? "",
          "Microsoft",
          "WinGet",
          "Packages",
          "Gyan.FFmpeg_*",
          "ffmpeg-*",
          "bin",
          exe
        )
      )
    );
    out.push(
      path.join(home, "scoop", "shims", exe),
      path.join(process.env.ProgramData ?? "C:\\ProgramData", "chocolatey", "bin", exe),
      path.join("C:\\", "ffmpeg", "bin", exe)
    );
  } else {
    out.push(`/usr/bin/${exe}`, `/usr/local/bin/${exe}`, `/opt/homebrew/bin/${exe}`, `/opt/local/bin/${exe}`);
  }
  return out;
}

/** Candidate /nix/store paths containing "ffmpeg" — cheap late-fallback scan. */
function nixStoreBins(exe: string): string[] {
  try {
    return fs
      .readdirSync("/nix/store")
      .filter((d) => d.includes("ffmpeg"))
      .map((d) => path.join("/nix/store", d, "bin", exe));
  } catch {
    return [];
  }
}

/** Minimal glob: expands `*` SEGMENTS (e.g. `Gyan.FFmpeg_*`) and returns paths. */
function glob(pattern: string): string[] {
  const segs = pattern.split(/[\\/]+/).filter(Boolean);
  const winDrive = /^[A-Za-z]:$/.test(segs[0] ?? "");
  const absolute = winDrive || pattern.startsWith("/") || pattern.startsWith("\\");
  let roots: string[] = winDrive ? [segs[0] + path.win32.sep] : absolute ? ["/"] : ["."];
  for (let i = absolute ? 1 : 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.includes("*")) {
      const re = new RegExp(
        "^" + seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/\\\\]*") + "$",
        "i"
      );
      const next: string[] = [];
      for (const root of roots) {
        let entries: string[] = [];
        try {
          entries = fs.readdirSync(root);
        } catch {
          continue;
        }
        for (const e of entries) if (re.test(e)) next.push(path.join(root, e));
      }
      roots = next;
    } else {
      roots = roots.map((r) => path.join(r, seg));
    }
    if (!roots.length) return [];
  }
  return roots;
}


