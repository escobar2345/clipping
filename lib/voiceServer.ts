import { spawn, type ChildProcess } from "child_process";
import path from "path";
import fs from "fs";

/**
 * Client for the Voice Studio Python bridge (voice-server/voice_server.py).
 *
 * The bridge is a tiny Flask HTTP server that wraps the chatterbox-master
 * TTS / voice-conversion library (Python/PyTorch). Next.js talks to it over
 * HTTP. Locally (`npm run dev` / `npm start` on your own PC) we spawn it
 * automatically from the Next.js process — no manual step needed.
 *
 * On Railway (any RAILWAY_* env var is set — Railway sets
 * RAILWAY_ENVIRONMENT_ID / RAILWAY_PROJECT_ID / etc. on every deploy;
 * RAILWAY_ENVIRONMENT alone is NOT reliable) auto-spawn is OFF by default:
 * the Node-only web service must NOT try to run Python/torch there.
 * Either leave the Voice Studio off on that deploy, or run voice_server.py
 * as a separate service and set VOICE_SERVER_URL to it.
 *
 * Env knobs:
 *   VOICE_SERVER_URL   — point at an externally hosted bridge (e.g. a second
 *                        Railway service). When set, we never spawn a process.
 *   VOICE_PORT         — local bridge port (default 8788).
 *   VOICE_PYTHON       — python executable used to spawn the bridge
 *                        (default: python3 on unix, python on Windows).
 *   VOICE_AUTO_START   — "1"/"0" to force auto-spawn on/off. Default: on
 *                        locally, OFF on Railway. (Anything except "0" counts
 *                        as on when explicitly set.)
 */

export const VOICE_DEFAULT_PORT = 8788;
const EXPLICIT_AUTO_START = process.env.VOICE_AUTO_START;
// On Railway (any RAILWAY_* env var is set), NEVER try to
// spawn a local Python bridge unless the user explicitly opted in with
// VOICE_AUTO_START=1. The Node-only web service has no torch/chatterbox
// installed — spawning python would just burn CPU/RAM/timeout on a $5 Hobby
// plan. Run voice_server.py as a separate service and set VOICE_SERVER_URL.
const IS_RAILWAY =
  !!(
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_ENVIRONMENT_ID ||
    process.env.RAILWAY_ENVIRONMENT_NAME ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_ID ||
    process.env.RAILWAY_DEPLOYMENT_ID
  );
const AUTO_START =
  EXPLICIT_AUTO_START !== undefined
    ? EXPLICIT_AUTO_START !== "0"
    : !IS_RAILWAY;
const PYTHON_BIN = process.env.VOICE_PYTHON;

export type VoiceHealth = {
  ok: boolean;
  ready: boolean;
  device: string;
  modelsLoaded: string[];
  models: string[];
  error?: string | null;
  serverTime?: number;
};

let child: ChildProcess | null = null;
let spawnInProgress: Promise<VoiceHealth> | null = null;

function baseUrl(): string {
  const configured = process.env.VOICE_SERVER_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const port = parseInt(process.env.VOICE_PORT || String(VOICE_DEFAULT_PORT), 10) || VOICE_DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

async function healthOrNull(): Promise<VoiceHealth | null> {
  try {
    const res = await fetch(`${baseUrl()}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return (await res.json()) as VoiceHealth;
  } catch {
    return null;
  }
}

let lastSpawnError = "";

function spawnServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverFile = path.join(process.cwd(), "voice-server", "voice_server.py");
    if (!fs.existsSync(serverFile)) {
      reject(
        new Error(
          `Could not find ${serverFile}. The Voice Studio needs the Python bridge ` +
            "server shipped with the repo — is the project missing the voice-server folder?"
        )
      );
      return;
    }
    const pythonBin = PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");

    // Child stdout/stderr go to a log file (not the node process' pipes) so a
    // long-running bridge can never wedge a CI/build shell or hold a terminal.
    let logFd: number | undefined;
    try {
      const logPath = path.join(process.cwd(), "voice-server", "voice-server.log");
      logFd = fs.openSync(logPath, "a");
    } catch {
      /* log file is optional — degrade to ignore */
    }
    const out = logFd ?? "ignore";

    let proc: ChildProcess;
    try {
      proc = spawn(pythonBin, [serverFile], { cwd: process.cwd(), stdio: ["ignore", out, out] });
    } catch (err: any) {
      if (logFd !== undefined) fs.closeSync(logFd);
      reject(new Error(`Could not start the Python voice bridge: ${err?.message ?? err}`));
      return;
    }

    child = proc;
    proc.unref(); // don't keep the Next.js process alive just for the bridge

    // On process exit, take the bridge down with us so we don't leak orphans.
    const killOnExit = () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    };
    process.once("exit", killOnExit);

    proc.once("error", (err) => {
      if (logFd !== undefined) fs.closeSync(logFd);
      lastSpawnError = err.message;
      reject(
        new Error(
          `Could not start the Python voice bridge: ${err.message}. ` +
            "Is Python installed and on PATH? (Set VOICE_PYTHON to the right interpreter if not.)"
        )
      );
    });
    proc.once("spawn", () => {
      if (logFd !== undefined) fs.closeSync(logFd); // child holds its own copy
      resolve();
    });
  });
}

/**
 * Makes sure the Python bridge is reachable. Returns its /health payload.
 * Throws a descriptive error when it can't be reached or started.
 */
export async function ensureVoiceServer(): Promise<VoiceHealth> {
  const healthy = await healthOrNull();
  if (healthy) return healthy;

  if (process.env.VOICE_SERVER_URL) {
    throw new Error(
      "Voice Studio bridge is not reachable at VOICE_SERVER_URL=" +
        baseUrl() +
        ". Make sure that server is running."
    );
  }
  if (!AUTO_START) {
    throw new Error(
      "Voice Studio bridge is not reachable and auto-start is disabled " +
        "(VOICE_AUTO_START=0). Start it yourself with: " +
        `python voice-server/voice_server.py${lastSpawnError ? ` (last error: ${lastSpawnError})` : ""}`
    );
  }

  if (!spawnInProgress) {
    spawnInProgress = (async () => {
      await spawnServer();
      const deadline = Date.now() + 120_000;
      let last: VoiceHealth | null = null;
      while (Date.now() < deadline) {
        last = await healthOrNull();
        if (last) return last;
        await new Promise((r) => setTimeout(r, 1500));
      }
      const detail = lastSpawnError ? ` Spawn error: ${lastSpawnError}` : "";
      throw new Error(
        "Voice Studio bridge did not become ready within 120s. On first " +
          "start this can take a while (installing models = big download, then " +
          "one-time loading). If it never comes up, check the logs above or run " +
          `'python voice-server/voice_server.py' manually.${detail}`
      );
    })();
  }

  try {
    return await spawnInProgress;
  } finally {
    spawnInProgress = null;
  }
}

/**
 * Forwards a multipart FormData body to the Python bridge and returns the
 * raw upstream Response (audio bytes, or a JSON error body). The Next.js
 * route handlers decide what to do with it.
 */
export async function forwardToVoice(
  endpoint: "/tts" | "/vc",
  form: FormData,
  timeoutMs = 900_000
): Promise<Response> {
  await ensureVoiceServer();
  return fetch(`${baseUrl()}${endpoint}`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
}