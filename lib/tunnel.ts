/**
 * Automatic public-URL resolution for Buffer posting.
 *
 * Buffer's API has no file-upload endpoint: you hand it a public URL and ITS
 * servers fetch the media. That means `localhost` never works — the file has
 * to be reachable from the public internet. This module makes the app "come
 * online" by itself when it posts:
 *
 *   1. If NEXT_PUBLIC_BASE_URL points at a real (non-localhost) domain AND
 *      the rendered video actually answers through it, that URL wins — the
 *      normal path in production (Fly.io, Vercel, a VPS…).
 *   2. Otherwise (local dev) it reuses an ngrok tunnel that is already
 *      running on the standard inspection port 4040 if it points at this
 *      app's port.
 *   3. Otherwise it SPAWNS ngrok itself (`ngrok http <PORT>`), using
 *      NGROK_AUTHTOKEN when provided, waits for the tunnel to come online,
 *      and hands back the fresh https://….ngrok-*.app URL.
 *
 * Result: no manual tunnel management. Paste a link, render, post — the app
 * figures out how to be reachable. Keep the app running until scheduled
 * posts publish though: Buffer re-fetches the file at publish time, and the
 * tunnel dies with the dev server.
 */

import { spawn, execFileSync } from "child_process";
import fs from "fs";
import path from "path";

/** Port of the app itself (next dev default 3000; Fly/other hosts set PORT). */
function appPort(): number {
  return Number(process.env.PORT) || 3000;
}

/** ngrok's standard web-inspection API port. */
const NGROK_INSPECT_PORT = 4040;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

/** A base URL that is meaningful for Buffer: resolvable from the internet. */
function isPublicBaseUrl(raw: string | undefined | null): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw.trim());
    return (
      (u.protocol === "https:" || u.protocol === "http:") &&
      !isLoopbackHost(u.hostname)
    );
  } catch {
    return false;
  }
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

interface NgrokTunnel {
  public_url?: string;
  config?: { addr?: string };
}

async function ngrokApiTunnels(inspectPort: number): Promise<NgrokTunnel[]> {
  try {
    const res = await fetch(`http://127.0.0.1:${inspectPort}/api/tunnels`, {
      signal: AbortSignal.timeout(2000),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const j: any = await res.json();
    return Array.isArray(j?.tunnels) ? j.tunnels : [];
  } catch {
    return [];
  }
}

/** First https tunnel whose local addr targets the app's port. */
function tunnelForAppPort(
  tunnels: NgrokTunnel[],
  port: number
): string | null {
  for (const t of tunnels) {
    const url = (t.public_url ?? "").replace(/\/+$/, "");
    const addr = (t.config?.addr ?? "")
      .replace(/^https?:\/\//, "")
      .replace(/^localhost(?=:)/, "127.0.0.1");
    if (url.startsWith("https://") && addr === `127.0.0.1:${port}`) {
      return url;
    }
  }
  return null;
}

/** Where's the ngrok binary? NGROK_PATH → common installs → PATH → verified
 *  by actually running `version` (pip/npm "ngrok" shims exist but may not be
 *  the real agent, so a name on PATH alone isn't enough). */
let cachedBinary: string | null | undefined;

function ngrokBinaryCandidates(): string[] {
  const found: string[] = [];
  const push = (p?: string | null) => {
    if (p && !found.includes(p)) found.push(p);
  };

  push(process.env.NGROK_PATH?.trim());

  const common =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\ngrok\\ngrok.exe",
          path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "ngrok.exe"),
          path.join(process.env.LOCALAPPDATA ?? "", "ngrok", "ngrok.exe"),
          path.join(process.env.USERPROFILE ?? "", ".ngrok2", "ngrok.exe"), // pyngrok's agent
          path.join(process.env.USERPROFILE ?? "", "scoop", "shims", "ngrok.exe"),
          "C:\\ngrok\\ngrok.exe",
        ]
      : ["/usr/local/bin/ngrok", "/opt/homebrew/bin/ngrok", "/usr/bin/ngrok"];
  for (const c of common) push(c);

  try {
    const probe = process.platform === "win32" ? "where" : "which";
    const out = execFileSync(probe, ["ngrok"], { encoding: "utf8" });
    for (const line of out.split(/\r?\n/)) push(line.trim());
  } catch {
    /* not on PATH */
  }

  return found.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function findNgrokBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary;
  for (const p of ngrokBinaryCandidates()) {
    try {
      const v = execFileSync(p, ["version"], {
        encoding: "utf8",
        timeout: 8000,
      }).toLowerCase();
      if (v.includes("ngrok")) {
        cachedBinary = p;
        return p;
      }
    } catch {
      /* try the next candidate */
    }
  }
  cachedBinary = null;
  return null;
}

/** Public URL of a tunnel this module spawned (null = none yet). */
let spawnedUrl: string | null = null;

const AUTH_HELP =
  "ngrok needs an authtoken: set NGROK_AUTHTOKEN in .env.local (get it at " +
  "dashboard.ngrok.com → Your Authtoken) or run `ngrok config add-authtoken <token>` once.";

/**
 * Spawns `ngrok http <port>` and waits for the https tunnel URL. No config
 * files: ngrok loads its own default config (that's where the authtoken
 * lives), we pass only optional overrides, and we read the tunnel URL from
 * the agent's JSON log stream — which works even if ngrok's web inspection
 * UI (127.0.0.1:4040) can't bind because another ngrok is already running.
 * The process is detached; it serves for the lifetime of the dev server.
 */
async function spawnNgrokIfNeeded(port: number): Promise<string> {
  // A previous spawn may still be alive — verify before spawning again.
  if (spawnedUrl) {
    const alive =
      tunnelForAppPort(await ngrokApiTunnels(NGROK_INSPECT_PORT), port) ??
      spawnedUrl;
    if (alive) return alive;
    spawnedUrl = null;
  }

  const bin = findNgrokBinary();
  if (!bin) {
    throw new Error(
      "This app could not make itself publicly reachable for Buffer: ngrok is " +
        "not installed. Fix with ONE of: (a) install ngrok — `winget install " +
        "ngrok.ngrok` — and restart the dev server; (b) point NGROK_PATH at the " +
        "ngrok.exe binary; (c) set NEXT_PUBLIC_BASE_URL to an already-deployed " +
        "domain. " +
        AUTH_HELP
    );
  }

  const args: string[] = [
    "http",
    String(port),
    "--log=stdout",
    "--log-format=json",
  ];
  const token = process.env.NGROK_AUTHTOKEN?.trim();
  if (token) args.push(`--authtoken=${token}`);
  // Optional reserved static domain (one free per ngrok account) — keeps the
  // same public URL across restarts, which scheduled Buffer posts need.
  const domain = process.env.NGROK_DOMAIN?.trim();
  if (domain) args.push(`--domain=${domain}`);

  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  const absorb = (d: any) => {
    out += String(d);
    if (out.length > 60_000) out = out.slice(-60_000);
  };
  child.stdout?.on("data", absorb);
  child.stderr?.on("data", absorb);
  child.unref();
  child.on("exit", () => {
    spawnedUrl = null;
  });

  /** Newest JSON log line with an https url forwarding to `port`. */
  const urlFromLogs = (): string | null => {
    const lines = out.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith("{")) continue;
      try {
        const j = JSON.parse(line);
        const url: string = j.url ?? "";
        const addr: string = String(j.addr ?? "");
        if (
          typeof url === "string" &&
          url.startsWith("https://") &&
          (addr.endsWith(`:${port}`) || addr === `:${port}`)
        ) {
          return url.replace(/\/+$/, "");
        }
      } catch {
        /* partial line — keep scanning */
      }
    }
    return null;
  };

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await sleep(500);
    const url =
      urlFromLogs() ??
      tunnelForAppPort(await ngrokApiTunnels(NGROK_INSPECT_PORT), port);
    if (url) {
      spawnedUrl = url;
      console.log(`[tunnel] ngrok online: ${url} → http://127.0.0.1:${port}`);
      return url;
    }
    if (child.exitCode !== null) break;
  }

  const tail = out.trim().slice(-500);
  throw new Error(
    "Started ngrok but no tunnel came online within 20s." +
      (tail ? ` ngrok said: ${tail}` : "") +
      ` ${AUTH_HELP}` +
      " (If another ngrok is already running, stop it first — free-tier " +
      "accounts allow one session/endpoint.)"
  );
}

/** Cheap self-check: can this URL be fetched right now? HEAD, with a ranged
 *  GET fallback for servers that reject HEAD (405). */
async function urlReachable(u: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(u, {
      method: "HEAD",
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (res.ok) return true;
    if (res.status === 405 || res.status === 501) {
      const g = await fetch(u, {
        headers: { Range: "bytes=0-1" },
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
      return g.ok || g.status === 206;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The REAL port the app is listening on. `process.env.PORT` lies when
 * .env.local sets PORT but Next dev auto-increments past busy ports (saw it
 * bind 3002 while .env.local said 3001). Instead, probe a small port window
 * for the one that actually answers for the rendered file — deterministic,
 * and it also skips foreign apps that happen to squat a nearby port.
 */
async function findLocalAppPort(renderedPath?: string): Promise<number> {
  const preferred = appPort();
  const candidates = [preferred, 3000, 3001, 3002, 3003, 3004, 3005].filter(
    (v, i, a) => a.indexOf(v) === i
  );
  // Probing the exact video path disambiguates OUR app from any other
  // server squatting a nearby port (only ours has the render).
  const probePath = renderedPath ?? "/";
  for (const p of candidates) {
    if (await urlReachable(`http://127.0.0.1:${p}${probePath}`, 1500)) {
      if (p !== preferred) {
        console.warn(
          `[tunnel] PORT env says ${preferred} but the app actually answers on ${p} — using ${p}`
        );
      }
      return p;
    }
  }
  return preferred;
}

/**
 * Resolves the base URL Buffer should fetch the video from:
 * NEXT_PUBLIC_BASE_URL (verified reachable) → existing ngrok → auto-spawn ngrok.
 * `renderedPath` (e.g. "/renders/clip-0.mp4") enables the reachability check;
 * without it a set-and-public NEXT_PUBLIC_BASE_URL is trusted as-is.
 */
export async function getPublicBaseUrl(renderedPath?: string): Promise<string> {
  const envUrl = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (isPublicBaseUrl(envUrl)) {
    const base = stripTrailingSlash(envUrl!);
    if (!renderedPath || (await urlReachable(`${base}${renderedPath}`))) {
      return base;
    }
    // Env URL is set but the video does not answer through it (dead domain,
    // or a deployed copy that doesn't have THIS render) → fall through to ngrok.
    console.warn(
      "[tunnel] NEXT_PUBLIC_BASE_URL is set but the video did not answer through it — falling back to ngrok"
    );
  }

  const port = await findLocalAppPort(renderedPath);

  // 1) An ngrok the user started themselves (`ngrok http 3000`)? Reuse it.
  const reused = tunnelForAppPort(
    await ngrokApiTunnels(NGROK_INSPECT_PORT),
    port
  );
  if (reused) return reused;

  // 2) Nothing usable — spawn our own.
  return spawnNgrokIfNeeded(port);
}

export interface TunnelStatus {
  mode: "env" | "ngrok" | "none";
  url: string | null;
  note?: string;
}

/**
 * Passive view of what posting would use right now. Does NOT spawn anything —
 * the tunnel comes online on demand when a post is actually made.
 */
export async function tunnelStatus(): Promise<TunnelStatus> {
  const envUrl = process.env.NEXT_PUBLIC_BASE_URL?.trim();
  if (isPublicBaseUrl(envUrl)) {
    return { mode: "env", url: stripTrailingSlash(envUrl!) };
  }

  const port = appPort();
  const existing =
    tunnelForAppPort(await ngrokApiTunnels(NGROK_INSPECT_PORT), port) ??
    spawnedUrl;
  if (existing) {
    return { mode: "ngrok", url: existing };
  }

  return {
    mode: "none",
    url: null,
    note:
      "No public URL yet. Posting will start an ngrok tunnel automatically — " +
      "make sure ngrok is installed (winget install ngrok.ngrok) and put your " +
      "token from dashboard.ngrok.com in .env.local as NGROK_AUTHTOKEN. " +
      "Alternatively set NEXT_PUBLIC_BASE_URL to a deployed domain. Keep the " +
      "app running until scheduled posts publish: Buffer re-fetches the video " +
      "at publish time and the tunnel dies with the dev server.",
  };
}