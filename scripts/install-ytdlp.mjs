#!/usr/bin/env node
/**
 * postinstall: fetch the official standalone yt-dlp binary into vendor/bin/.
 *
 * The GitHub release assets (yt-dlp.exe / yt-dlp_linux / yt-dlp_macos) are
 * PyInstaller builds that bundle their own Python — no interpreter required.
 * This runs during `npm ci` in the Railway container, which ships with neither
 * yt-dlp nor python, so render/analyze of external URLs would otherwise fail
 * with "spawn py ENOENT".
 *
 * Failure policy: if the download fails but a system yt-dlp exists (local dev
 * machines), warn and continue; otherwise exit 1 so the build goes red instead
 * of deploying an app that 500s at render time.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ASSETS = {
  "win32-x64": "yt-dlp.exe",
  "darwin-x64": "yt-dlp_macos",
  "darwin-arm64": "yt-dlp_macos",
  "linux-x64": "yt-dlp_linux",
  "linux-arm64": "yt-dlp_linux_aarch64",
};

const isWin = process.platform === "win32";
const outDir = path.join(process.cwd(), "vendor", "bin");
const outFile = path.join(outDir, isWin ? "yt-dlp.exe" : "yt-dlp");
const existingYtdlpWorks = fs.existsSync(outFile) && runs(outFile);

/** Does this binary run and answer --version? */
function runs(bin) {
  try {
    const r = spawnSync(bin, ["--version"], {
      stdio: "ignore",
      timeout: 30_000,
      windowsHide: true,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Is yt-dlp available on PATH (dev machines)? */
function systemYtdlp() {
  const r = spawnSync(isWin ? "yt-dlp.exe" : "yt-dlp", ["--version"], {
    stdio: "ignore",
    timeout: 30_000,
    windowsHide: true,
  });
  return r.status === 0;
}

function fail(msg, err) {
  console.error(`[install-ytdlp] FAILED: ${msg}`);
  if (err) console.error(`[install-ytdlp] ${err?.stack ?? err}`);
  if (systemYtdlp()) {
    console.warn(
      "[install-ytdlp] Continuing: a system yt-dlp is on PATH, so the app can still run locally."
    );
    process.exit(0);
  }
  if (existingYtdlpWorks) {
    console.warn(
      `[install-ytdlp] Keeping the existing working yt-dlp binary at ${outFile}.`
    );
    process.exit(0);
  }
  console.error(
    "[install-ytdlp] No system yt-dlp either. Fix network access to github.com " +
      "or install yt-dlp manually, then retry. Without it, rendering clips " +
      "whose source is an external URL will fail."
  );
  process.exit(1);
}

const asset = ASSETS[`${process.platform}-${process.arch}`];
if (!asset) {
  fail(`no standalone binary for ${process.platform}-${process.arch}; install yt-dlp yourself`);
}

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`;
console.log(`[install-ytdlp] downloading ${url}`);

try {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const tmp = `${outFile}.download`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  if (!isWin) fs.chmodSync(tmp, 0o755);
  if (!runs(tmp)) throw new Error("downloaded binary failed its --version check");
  // Copy only after the downloaded binary passed --version. Unlike rename,
  // copyFileSync safely replaces an existing binary on Windows as well.
  fs.copyFileSync(tmp, outFile);
  fs.rmSync(tmp, { force: true });
  console.log(`[install-ytdlp] updated -> ${outFile}`);
} catch (err) {
  fail(`could not download ${url}`, err);
}