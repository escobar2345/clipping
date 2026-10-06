// Higgsfield driver — CLI-first.
//
// Higgsfield no longer issues API keys: accounts authenticate with OAuth
// through the `higgsfield` CLI (`higgsfield auth login`). This module drives
// the CLI's native binary (`hf`) as a subprocess — the transport Higgsfield
// documents — instead of the old API-key-authenticated MCP bridge at
// bridge.higgsfield.ai/mcp (that endpoint requires a legacy credential and
// returns 401/404 without one).
//
// No env vars are required when the CLI is installed and signed in:
//
//   npm i -g @higgsfield/cli
//   higgsfield auth login
//
// A legacy path is kept for backwards compatibility: if HIGGSFIELD_API_KEY is
// set, this module uses the @modelcontextprotocol/sdk HTTP client against
// HIGGSFIELD_MCP_URL (default bridge.higgsfield.ai/mcp) exactly like before.
//
// The public API consumed elsewhere (connectHiggsfield / listHiggsfieldTools /
// callHiggsfieldTool / disconnectHiggsfield) is unchanged, so the GLM tool-use
// loop, the MCP→OpenAI adapter and the render pipeline keep working — only the
// transport changed.

import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";

const execFileAsync = promisify(execFile);

export interface McpTool {
  name: string;
  description: string;
  inputSchema: any;
}

export interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

export interface HiggsfieldStatus {
  available: boolean;
  mode: "cli" | "bridge" | "none";
  cliPath: string | null;
  cliVersion: string | null;
  loggedIn: boolean;
  reason: string;
  setup: string[];
}

const DEFAULT_VIDEO_MODEL = "seedance_2_5";
const DEFAULT_IMAGE_MODEL = "nano_banana_2";

// ---------------------------------------------------------------------------
// CLI binary discovery
// ---------------------------------------------------------------------------

let _binCache: { path: string | null; checkedAt: number } | null = null;
let _npmRootCache: string | null | undefined;

function envPathTrim(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/** Resolve the npm global node_modules dir (cached after the first call). */
async function npmGlobalRoot(): Promise<string | null> {
  if (_npmRootCache !== undefined) return _npmRootCache;
  const direct = process.env.APPDATA
    ? path.join(process.env.APPDATA, "npm", "node_modules")
    : null;
  if (direct && fs.existsSync(path.join(direct, "@higgsfield"))) {
    _npmRootCache = direct;
    return direct;
  }
  try {
    // On Windows `npm` is a .cmd shim (execFile can't launch it), so run its
    // real JS entry with node; on POSIX the plain `npm` script is fine.
    const npmCli =
      process.platform === "win32" && direct
        ? path.join(direct, "npm", "bin", "npm-cli.js")
        : null;
    const argv0 = npmCli && fs.existsSync(npmCli) ? process.execPath : "npm";
    const rest =
      npmCli && fs.existsSync(npmCli) ? [npmCli, "root", "-g"] : ["root", "-g"];
    const { stdout } = await execFileAsync(argv0, rest, {
      timeout: 20_000,
      maxBuffer: 1 * 1024 * 1024,
    });
    const dir = stdout.trim();
    _npmRootCache = dir && fs.existsSync(dir) ? dir : null;
  } catch {
    _npmRootCache = null;
  }
  return _npmRootCache;
}

/**
 * Locate the Higgsfield native binary:
 *   1. HIGGSFIELD_CLI_PATH override (a direct path to the binary),
 *   2. the npm global package's vendor/hf[.exe],
 *   3. common POSIX install dirs,
 *   4. bare `hf` on PATH (curl/brew installs on POSIX — a real binary there).
 * Returns null when the CLI doesn't appear to be installed.
 */
export async function resolveHiggsfieldBinary(): Promise<string | null> {
  if (_binCache && Date.now() - _binCache.checkedAt < 5_000) return _binCache.path;
  const found = await doResolveBinary();
  _binCache = { path: found, checkedAt: Date.now() };
  return found;
}

async function doResolveBinary(): Promise<string | null> {
  const override = envPathTrim("HIGGSFIELD_CLI_PATH");
  if (override) return override; // caller surfaces a clear error if it's bogus

  const npmRoot = await npmGlobalRoot();
  if (npmRoot) {
    const exe = process.platform === "win32" ? "hf.exe" : "hf";
    const p = path.join(npmRoot, "@higgsfield", "cli", "vendor", exe);
    if (fs.existsSync(p)) return p;
  }

  const home = os.homedir();
  const exe = process.platform === "win32" ? "hf.exe" : "hf";
  const candidates = [
    path.join(home, ".npm-global", "lib", "node_modules", "@higgsfield", "cli", "vendor", exe),
    path.join(home, ".local", "share", "npm", "lib", "node_modules", "@higgsfield", "cli", "vendor", exe),
  ];
  if (process.platform !== "win32") {
    candidates.push("/usr/local/lib/node_modules/@higgsfield/cli/vendor/hf");
    candidates.push("hf"); // curl/brew installs put a real binary on PATH
  }
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}
// ---------------------------------------------------------------------------
// Process execution
// ---------------------------------------------------------------------------

function runBare(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; maxBufferBytes?: number } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBufferBytes ?? 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err: any, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : null) : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      }
    );
  });
}

/** Run the Higgsfield CLI. Throws only if the binary is missing entirely;
 *  non-zero exits are returned in the result. */
async function runHf(
  args: string[],
  opts: { timeoutMs?: number } = {}
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const bin = await resolveHiggsfieldBinary();
  if (!bin) {
    const err: any = new Error(
      "Higgsfield CLI not found. Install it with: npm i -g @higgsfield/cli"
    );
    err.hfMissing = true;
    throw err;
  }
  return runBare(bin, args, { timeoutMs: opts.timeoutMs ?? 60_000 });
}

// ---------------------------------------------------------------------------
// Readiness / login state (what replaced the HIGGSFIELD_API_KEY requirement)
// ---------------------------------------------------------------------------

let _statusCache: { status: HiggsfieldStatus; at: number } | null = null;

/**
 * Is Higgsfield usable right now? (CLI installed + signed in, or a legacy
 * HIGGSFIELD_API_KEY is set.) Cached ~15s; pass force=true to re-probe.
 */
export async function getHiggsfieldStatus(force = false): Promise<HiggsfieldStatus> {
  if (!force && _statusCache && Date.now() - _statusCache.at < 15_000) {
    return _statusCache.status;
  }

  // Legacy bridge: someone still has a working key.
  if (envPathTrim("HIGGSFIELD_API_KEY")) {
    const status: HiggsfieldStatus = {
      available: true,
      mode: "bridge",
      cliPath: null,
      cliVersion: null,
      loggedIn: true,
      reason:
        "Legacy HIGGSFIELD_API_KEY is set — using the deprecated HTTP bridge transport.",
      setup: [],
    };
    _statusCache = { status, at: Date.now() };
    return status;
  }

  const bin = await resolveHiggsfieldBinary();
  if (!bin) {
    const status: HiggsfieldStatus = {
      available: false,
      mode: "cli",
      cliPath: null,
      cliVersion: null,
      loggedIn: false,
      reason: "The Higgsfield CLI is not installed on this machine.",
      setup: ["npm i -g @higgsfield/cli", "higgsfield auth login"],
    };
    _statusCache = { status, at: Date.now() };
    return status;
  }

  let cliVersion: string | null = null;
  try {
    const v = await runHf(["version"], { timeoutMs: 10_000 });
    cliVersion = (v.stdout.match(/higgsfield\s+(v?[\d.]+)/i) || [])[1] ?? null;
  } catch {
    /* non-fatal */
  }

  // `higgsfield auth token` exits 0 when signed in, and 2 otherwise.
  let loggedIn = false;
  try {
    const t = await runHf(["auth", "token"], { timeoutMs: 10_000 });
    loggedIn = t.code === 0;
  } catch {
    /* non-fatal */
  }

  const status: HiggsfieldStatus = {
    available: loggedIn,
    mode: "cli",
    cliPath: bin,
    cliVersion,
    loggedIn,
    reason: loggedIn
      ? "Higgsfield CLI is signed in — edit plans can generate AI media."
      : "The Higgsfield CLI is installed but not signed in. Run: higgsfield auth login",
    setup: loggedIn ? [] : ["higgsfield auth login"],
  };
  _statusCache = { status, at: Date.now() };
  return status;
}

// ---------------------------------------------------------------------------
// Tool catalog (CLI-backed)
// ---------------------------------------------------------------------------

interface CatalogTool {
  name: string;
  description: string;
  inputSchema: any;
}

/** The tools the GLM model can call. Each maps to a `higgsfield` CLI invocation.
 *  Read-only — this is the static equivalent of what the old MCP bridge
 *  used to advertise dynamically. */
const CLI_TOOL_CATALOG: CatalogTool[] = [
  {
    name: "generate_video",
    description:
      "Generate a short AI video clip with Higgsfield (B-roll, background, transition, VFX, or stock-like footage). Returns the finished video URL. Use a vivid, self-contained scene description in the prompt.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed scene description of the video to generate." },
        duration: { type: "number", description: "Video length in seconds (1–10).", default: 5 },
        aspect_ratio: { type: "string", enum: ["1:1", "9:16", "16:9", "4:3", "3:4"], default: "9:16" },
        resolution: { type: "string", enum: ["480p", "720p", "1080p"], default: "1080p" },
        sound: { type: "string", enum: ["off", "auto"], description: "Whether to include synthesized audio.", default: "off" },
        model: { type: "string", description: `Higgsfield video model slug (default "${DEFAULT_VIDEO_MODEL}").`, default: DEFAULT_VIDEO_MODEL },
      },
      required: ["prompt"],
    },
  },
  {
    name: "generate_image",
    description:
      "Generate an AI image with Higgsfield (overlay graphics, title/end cards, backgrounds, thumbnails). Returns the finished image URL.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detailed description of the image to generate." },
        aspect_ratio: { type: "string", enum: ["1:1", "9:16", "16:9", "4:3", "3:4"], default: "16:9" },
        resolution: { type: "string", enum: ["1k", "2k", "4k"], default: "2k" },
        quality: { type: "string", enum: ["low", "medium", "high", "ultra"], default: "high" },
        model: { type: "string", description: `Higgsfield image model slug (default "${DEFAULT_IMAGE_MODEL}").`, default: DEFAULT_IMAGE_MODEL },
      },
      required: ["prompt"],
    },
  },
  {
    name: "reframe_video",
    description:
      "Reframe an existing video to a target aspect ratio (e.g. re-format a 16:9 clip to 9:16 for Shorts/TikTok/Reels). Pass a media URL (or a local file path the server can read) as `video`. Returns the reframed video URL.",
    inputSchema: {
      type: "object",
      properties: {
        video: { type: "string", description: "Source video URL or local path to reframe." },
        aspect_ratio: { type: "string", enum: ["1:1", "9:16", "16:9", "4:3", "3:4"], default: "9:16" },
        resolution: { type: "string", enum: ["480p", "720p", "1080p"], default: "720p" },
      },
      required: ["video"],
    },
  },
];
/** Convenience boolean wrapper around getHiggsfieldStatus(). */
export async function higgsfieldConfigured(): Promise<boolean> {
  return (await getHiggsfieldStatus()).available;
}

/** Drop cached probes (useful after an auth login/logout). */
export function invalidateHiggsfieldStatus(): void {
  _statusCache = null;
  _binCache = null;
}
// ---------------------------------------------------------------------------
// Clients (CLI shim + legacy HTTP bridge)
// ---------------------------------------------------------------------------

const CLI_CLIENT_KIND = "cli";
let _client: any = null;
let _transport: any = null;
let _toolsCache: McpTool[] | null = null;

/**
 * Lazily import the MCP SDK (ESM-only, so dynamic import is required).
 * Uses the SDK's public subpath exports — since v1.x the package ships an
 * `exports` map, so deep `dist/...` specifiers no longer resolve.
 */
async function loadSdk(): Promise<any> {
  try {
    const indexMod = await import("@modelcontextprotocol/sdk/client");
    const httpMod = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    return {
      Client: indexMod.Client,
      StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
    };
  } catch (err: any) {
    throw new Error(
      "MCP SDK failed to load — run `npm install @modelcontextprotocol/sdk`. " +
        String(err?.message ?? err)
    );
  }
}

function bridgeUrl(): string {
  return process.env.HIGGSFIELD_MCP_URL || "https://bridge.higgsfield.ai/mcp";
}

/** Legacy HTTP-bridge client (only used when HIGGSFIELD_API_KEY is set). */
async function connectLegacyBridge(): Promise<any | null> {
  if (_client) {
    try {
      await _client.ping();
      return _client;
    } catch {
      try { await _transport?.close?.(); } catch {}
      _client = null;
      _transport = null;
    }
  }
  try {
    const { Client, StreamableHTTPClientTransport } = await loadSdk();
    const url = new URL(bridgeUrl());
    const apiKey = process.env.HIGGSFIELD_API_KEY || "";
    _transport = new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey },
      },
    });
    _client = new Client(
      { name: "long2short-higgsfield", version: "0.1.0" },
      { capabilities: {} }
    );
    await _client.connect(_transport);
    _toolsCache = null;
    return _client;
  } catch (err: any) {
    console.error("[Higgsfield] legacy bridge connection failed:", err?.message ?? String(err));
    _client = null;
    _transport = null;
    return null;
  }
}

/**
 * Connect (or reuse) a Higgsfield client. Returns null when Higgsfield is not
 * configured (CLI missing / not signed in, and no legacy API key). The caller
 * only ever uses ping()/listTools()/callTool(), so the CLI shim and the MCP
 * client are interchangeable.
 */
export async function connectHiggsfield(): Promise<any | null> {
  const status = await getHiggsfieldStatus();
  if (!status.available) return null;

  if (status.mode === "bridge") return connectLegacyBridge();

  // CLI-backed lightweight client.
  return {
    kind: CLI_CLIENT_KIND,
    ping: async () => true,
    listTools: async () => ({ tools: CLI_TOOL_CATALOG }),
    callTool: async (req: { name: string; arguments?: Record<string, any> }) =>
      (await runCliTool(req.name, req.arguments || {})) as McpToolResult,
    close: async () => {},
  };
}

/**
 * List available Higgsfield tools. Cached after the first successful call.
 * Returns [] if Higgsfield is not configured.
 */
export async function listHiggsfieldTools(): Promise<McpTool[]> {
  if (_toolsCache) return _toolsCache;

  const client = await connectHiggsfield();
  if (!client) return [];

  try {
    let tools: any[];
    if (client.kind === CLI_CLIENT_KIND) {
      tools = CLI_TOOL_CATALOG;
    } else {
      const res = await client.listTools();
      tools = res.tools || [];
    }
    _toolsCache = tools.map((t: any) => ({
      name: t.name,
      description: t.description || "",
      inputSchema: t.inputSchema || { type: "object", properties: {} },
    }));
    return _toolsCache;
  } catch (err: any) {
    console.error("[Higgsfield] listTools failed:", err?.message ?? String(err));
    return [];
  }
}

/**
 * Call a Higgsfield tool. Returns an MCP-shaped result (text JSON with the
 * generated media URL on success, or an error message on failure).
 */
export async function callHiggsfieldTool(
  toolName: string,
  args: Record<string, any>
): Promise<McpToolResult> {
  const client = await connectHiggsfield();
  if (!client) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Higgsfield is not configured. Run `npm i -g @higgsfield/cli` and then `higgsfield auth login`.",
        },
      ],
    };
  }

  try {
    if (client.kind === CLI_CLIENT_KIND) {
      return await client.callTool({ name: toolName, arguments: args });
    }
    const result = await client.callTool({ name: toolName, arguments: args || {} });
    return result as McpToolResult;
  } catch (err: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Tool call "${toolName}" failed: ${err?.message ?? String(err)}`,
        },
      ],
    };
  }
}

/** Close the connection (e.g. for graceful shutdown). */
export async function disconnectHiggsfield(): Promise<void> {
  try { if (_transport) await _transport.close(); } catch {}
  _client = null;
  _transport = null;
  _toolsCache = null;
  invalidateHiggsfieldStatus();
}
// ---------------------------------------------------------------------------
// CLI invocation mapping
// ---------------------------------------------------------------------------

function str(v: any): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
}

function pushFlag(argv: string[], flag: string, value: string | number | undefined): void {
  if (value !== undefined && value !== "") argv.push(flag, String(value));
}

/** Map a semantic tool call to `higgsfield` CLI arguments. */
export function buildCliArgs(name: string, args: Record<string, any>): string[] {
  if (name === "generate_video") {
    const model = str(args.model) || DEFAULT_VIDEO_MODEL;
    const argv = ["generate", "create", model, "--prompt", str(args.prompt) || "", "--wait", "--json"];
    pushFlag(argv, "--duration", typeof args.duration === "number" ? Math.max(1, Math.min(10, Math.round(args.duration))) : undefined);
    pushFlag(argv, "--aspect_ratio", str(args.aspect_ratio));
    pushFlag(argv, "--resolution", str(args.resolution));
    pushFlag(argv, "--sound", str(args.sound));
    return argv;
  }
  if (name === "generate_image") {
    const model = str(args.model) || DEFAULT_IMAGE_MODEL;
    const argv = ["generate", "create", model, "--prompt", str(args.prompt) || "", "--wait", "--json"];
    pushFlag(argv, "--aspect_ratio", str(args.aspect_ratio));
    pushFlag(argv, "--resolution", str(args.resolution));
    pushFlag(argv, "--quality", str(args.quality));
    return argv;
  }
  if (name === "reframe_video") {
    const argv = ["generate", "workflow", "reframe", "--video", str(args.video) || "", "--wait", "--json"];
    pushFlag(argv, "--aspect-ratio", str(args.aspect_ratio));
    pushFlag(argv, "--resolution", str(args.resolution));
    return argv;
  }
  throw new Error(`Unknown Higgsfield tool "${name}"`);
}

/** Best-effort extraction of the generated media URL from `--json` stdout. */
export function extractMediaUrl(stdout: string): string | null {
  const jsonMatch = stdout.match(/{[\s\S]*}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      const out: string[] = [];
      const push = (v: any) => {
        if (typeof v === "string" && /^https?:\/\//i.test(v) && !out.includes(v)) out.push(v);
      };
      const walk = (node: any) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        for (const key of ["result_url", "resultUrl", "url", "file_url", "id", "video_url"]) {
          push(node[key]);
        }
        for (const key of ["result", "results", "output", "data", "media", "assets"]) {
          if (node[key] !== undefined) walk(node[key]);
        }
      };
      walk(data);
      if (out.length) return out[0];
    } catch {
      /* not JSON — fall through to line scan */
    }
  }
  const m = stdout.match(/https?:\/\/[^\s"'<>]+/);
  return m ? m[0].replace(/[)\]},]+$/, "") : null;
}

/** Run one semantic tool call through the Higgsfield CLI and return an MCP-shaped result. */
export async function runCliTool(
  name: string,
  args: Record<string, any>
): Promise<McpToolResult> {
  try {
    const argv = buildCliArgs(name, args);
    // Generations can take several minutes — allow a long but finite wait.
    const res = await runHf(argv, { timeoutMs: 10 * 60 * 1000 });
    if (res.code !== 0) {
      const msg = (res.stderr || res.stdout || "unknown CLI error").trim();
      const hint = /not authenticated|auth login/i.test(msg)
        ? " Run `higgsfield auth login`."
        : "";
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: `higgsfield ${name} failed (exit ${res.code})${hint}`,
              detail: msg.slice(0, 2000),
            }),
          },
        ],
      };
    }
    const combined = `${res.stdout}\n${res.stderr}`;
    const url = extractMediaUrl(combined);
    if (!url) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Could not find a result URL in the Higgsfield CLI output for "${name}". Raw output:\n${combined.slice(0, 4000)}`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "completed",
            tool: name,
            url,
            prompt: str(args.prompt) ?? str(args.video) ?? "",
          }),
        },
      ],
    };
  } catch (err: any) {
    return { isError: true, content: [{ type: "text", text: String(err?.message ?? err) }] };
  }
}