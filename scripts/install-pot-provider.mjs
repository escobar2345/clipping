#!/usr/bin/env node
/**
 * postinstall: fetch + build the bgutil POT provider (option b/a repo) into
 * vendor/bgutil-ytdlp-pot-provider/ — the yt-dlp plugin that generates the
 * proof-of-origin tokens YouTube demands from flagged IPs ("Sign in to confirm
 * you're not a bot"). Also builds the companion HTTP server (port 4416) that
 * lib/potServer.ts boots with the app.
 *
 * Non-fatal by design: this is the zero-config layer. The guaranteed fix for
 * datacenter IPs is cookies (YTDLP_COOKIES), so a failure here only warns and
 * lets `npm ci` succeed — the runtime logs a warning instead.
 *
 * Requires: git, network to github.com, Node >= 22 to RUN the server (the
 * build itself runs on whatever Node npm uses).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const VERSION = "2.0.2"; // must match the plugin the server ships with
const repo = path.join(process.cwd(), "vendor", "bgutil-ytdlp-pot-provider");
const pluginDir = path.join(repo, "plugin");
const serverDir = path.join(repo, "server");
const builtEntry = path.join(serverDir, "build", "main.js");

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 10 * 60_000,
    windowsHide: true,
    shell: process.platform === "win32", // npm/npx are .cmd shims on Windows
  });
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split(/\r?\n/).slice(-8).join("\n");
    throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}\n${tail}`);
  }
}

// Already installed and built (local re-runs) → nothing to do.
if (fs.existsSync(builtEntry) && fs.existsSync(path.join(pluginDir, "yt_dlp_plugins"))) {
  console.log(`[pot-provider] already present: ${repo}`);
  process.exit(0);
}

try {
  fs.mkdirSync(path.dirname(repo), { recursive: true });
  if (!fs.existsSync(path.join(repo, ".git"))) {
    fs.rmSync(repo, { recursive: true, force: true });
    console.log(`[pot-provider] cloning bgutil-ytdlp-pot-provider@${VERSION}`);
    run("git", [
      "clone", "--single-branch", "--depth", "1",
      "--branch", VERSION,
      "https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git",
      repo,
    ], process.cwd());
  }

  if (!fs.existsSync(path.join(pluginDir, "yt_dlp_plugins"))) {
    throw new Error(`plugin layout unexpected: ${pluginDir}/yt_dlp_plugins missing`);
  }

  console.log("[pot-provider] installing + building the HTTP server (tsc)");
  run("npm", ["ci"], serverDir);
  run("npx", ["tsc"], serverDir);

  if (!fs.existsSync(builtEntry)) {
    throw new Error(`tsc succeeded but ${builtEntry} does not exist`);
  }
  console.log(`[pot-provider] ready -> plugin: ${pluginDir}, server: ${builtEntry}`);
} catch (err) {
  console.warn(`[pot-provider] WARNING: install failed — continuing without the PO-token layer.`);
  console.warn(`[pot-provider] ${err?.message ?? err}`);
  console.warn(
    "[pot-provider] Renders keep working IF YTDLP_COOKIES (or YTDLP_PROXY) is set — " +
      "that is the documented fix for datacenter IPs anyway."
  );
  process.exit(0);
}