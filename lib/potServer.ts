/**
 * Boots the bgutil PO-token HTTP server (vendor/bgutil-ytdlp-pot-provider/server,
 * port 4416) alongside the Next.js process. yt-dlp's plugin talks to it to mint
 * proof-of-origin tokens, which is how we get past YouTube's
 * "Sign in to confirm you're not a bot" check on flagged IPs.
 *
 * Failure policy: never block boot. If the server can't start (not installed,
 * port taken, crashed repeatedly) we log and move on — yt-dlp still runs and
 * YTDLP_COOKIES / YTDLP_PROXY remain the guaranteed fallbacks.
 *
 * Set POT_SERVER_ENABLED=0 to skip spawning (e.g. if you run it externally).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const PORT = 4416;
const MAX_RESTARTS = 20;

let child: ChildProcess | null = null;
let restarts = 0;

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (open: boolean) => {
      sock.removeAllListeners();
      sock.destroy();
      resolve(open);
    };
    sock.setTimeout(1000, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function logLine(prefix: string, chunk: Buffer | string) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (line.trim()) console.log(`${prefix} ${line}`);
  }
}

export async function startPotServer(): Promise<void> {
  if (process.env.POT_SERVER_ENABLED === "0") {
    console.log("[pot] disabled via POT_SERVER_ENABLED=0");
    return;
  }

  const serverDir = path.join(process.cwd(), "vendor", "bgutil-ytdlp-pot-provider", "server");
  const entry = path.join(serverDir, "build", "main.js");

  if (!fs.existsSync(entry)) {
    console.warn(
      `[pot] PO-token server not built (${entry} missing) — run \`npm run install:pot\`. ` +
        "YouTube bot-checks will fall back to YTDLP_COOKIES / YTDLP_PROXY alone."
    );
    return;
  }

  // Something already listens (external instance / stray restart) → don't double-bind.
  if (await portOpen(PORT)) {
    console.log(`[pot] something already listens on :${PORT} — not starting our own`);
    return;
  }

  const proc = spawn(process.execPath, [entry], {
    cwd: serverDir,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child = proc;

  proc.stdout?.on("data", (c) => logLine("[pot]", c));
  proc.stderr?.on("data", (c) => logLine("[pot:error]", c));

  proc.on("error", (err) => {
    console.warn(`[pot] failed to spawn: ${err.message}`);
    child = null;
  });

  proc.on("exit", (code, signal) => {
    child = null;
    if (code === 0) return; // clean shutdown (process exit)
    if (restarts >= MAX_RESTARTS) {
      console.warn(`[pot] crashed ${MAX_RESTARTS}+ times (last: code=${code} signal=${signal}) — giving up`);
      return;
    }
    restarts += 1;
    console.warn(`[pot] exited (code=${code} signal=${signal}); restart #${restarts} in 5s`);
    setTimeout(() => void startPotServer(), 5_000).unref?.();
  });

  // The server takes a few seconds to bind (measured ~3-5s) — poll rather than
  // a single probe, then confirm it actually accepts connections.
  let up = false;
  for (let i = 0; i < 15 && child; i += 1) {
    await new Promise((r) => setTimeout(r, 1_000));
    if (await portOpen(PORT)) {
      up = true;
      break;
    }
  }
  if (child && up) {
    console.log(`[pot] PO-token server up on 127.0.0.1:${PORT}`);
  } else if (child) {
    console.warn(`[pot] spawned but :${PORT} not accepting after ~15s — check [pot] logs above`);
  }
}