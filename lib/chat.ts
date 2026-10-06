// Chat assistant brain. A fast flash-class model that can (1) PROPOSE posts
// to any saved Buffer channel and (2) fetch an existing post from any URL
// (yt-dlp / Apify, lib/socialFetch.ts) and rewrite it per-platform.
//
// PROPOSE-ONLY: runChat never executes anything. When a reply needs a real
// world effect it embeds ONE fenced ```action``` JSON block; the UI renders
// that behind a Confirm button, and only /api/chat/execute (user click) calls
// executePostAction / executeRepurposeAction. Nothing posts without a click.
import { listAccounts } from "./accounts";
import { listChannels, createPost } from "./buffer";
import { fetchPostContent } from "./socialFetch";
import { withRetry } from "./retry";
import { actionCatalogText, type ChatPageContext } from "./actions";
import { listTasks, ensureScheduler } from "./scheduler";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveViaPublicDns } from "./resilientDns";
// Transport note: NVIDIA calls in this module go through curl.exe (Windows
// schannel TLS) pinned to a public-DNS IP via --resolve — see the curlChatOnce
// comment for why. lib/resilientDns.ts still installs resilient DNS
// process-wide at boot (instrumentation.ts) for every other outbound call
// (NVIDIA SDK elsewhere in the app, Apify, Buffer).

const CHAT_MODEL =
  process.env.NVIDIA_CHAT_MODEL ?? "z-ai/glm-5.3";

function nvidiaBase(): string {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error("NVIDIA_API_KEY is not set — get one at build.nvidia.com");
  }
  return (process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(
    /\/+$/,
    ""
  );
}

/**
 * One chat completion via curl.exe (Windows schannel TLS) — NON-STREAMING.
 *
 * WHY CURL: this machine's network middlebox stalls node/OpenSSL TLS
 * connections to integrate.api.nvidia.com regardless of TLS version, DNS
 * strategy, or fetch implementation — verified with a TLS diagnostic on
 * 2026-09-03. curl.exe (schannel TLS stack, ships with Windows 10/11)
 * succeeds against the same endpoint on the same network, so this transport
 * shells out to it. The request body is written to a temp file
 * (`--data @file`) to avoid Windows command-line length limits, and the
 * resolved IP is pinned with --resolve (public DNS via lib/resilientDns.ts)
 * so curl never touches the flaky router resolver.
 *
 * WHY NOT STREAMING (SSE): decisive live testing on 2026-09-03 showed the
 * middlebox swallows SSE response streams SPECIFICALLY — every stream:true
 * call hung at "request fully sent, zero response bytes" (from the shell AND
 * the server, with a pinned IP), while every stream:false call through the
 * same stack succeeded (the edit-plan path has always been stream:false and
 * always worked). So this transport sends stream:false and reads ONE JSON
 * body. Consequence: nothing arrives until the whole generation finishes,
 * so there is no idle watchdog — curl's `-m` cap is the total timeout and
 * withRetry re-attempts transient failures.
 */
/**
 * ONE curl.exe POST to NVIDIA's chat completions endpoint with an optional
 * DNS pin. Non-streaming (stream:false) — see the transport note above.
 * Returns the assistant message content.
 */
function curlOnce(
  bodyFile: string,
  url: string,
  resolveArgs: string[],
  timeoutSec: number
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const child = spawn(
      "curl.exe",
      [
        "-sS",
        "--fail-with-body", // non-2xx HTTP → non-zero exit, body still on stdout
        "--connect-timeout",
        "8",
        "-m",
        String(timeoutSec),
        "-X",
        "POST",
        url,
        ...resolveArgs, // optional DNS pin — empty list = system resolver
        "-H",
        `Authorization: Bearer ${process.env.NVIDIA_API_KEY}`,
        "-H",
        "Content-Type: application/json",
        "--data",
        `@${bodyFile}`,
      ],
      { windowsHide: true }
    );

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (c: string) => (stderr += c));

    child.on("error", (err) =>
      done(() => reject(new Error(`curl network error: ${err.message}`)))
    );
    child.on("close", (code) => {
      if (code !== 0) {
        // curl -f exits 22 for any HTTP >= 400. The stderr text carries the
        // status ("The requested URL returned error: 500") — surface it as a
        // structured field so callers can tell a retryable 5xx edge blip from
        // an authoritative 4xx (bad model / no access / bad request).
        const statusMatch = (stderr + stdout).match(/error: (\d{3})/);
        const err = new Error(
          `NVIDIA chat network failure via curl (exit ${code}): ${
            stderr.trim() || stdout.trim().slice(-200) || "no output"
          }`
        );
        (err as any).httpStatus = statusMatch ? Number(statusMatch[1]) : undefined;
        done(() => reject(err));
        return;
      }
      // Non-streaming response: one JSON body containing the full message.
      try {
        const j = JSON.parse(stdout);
        const text = j.choices?.[0]?.message?.content;
        if (typeof text === "string" && text.trim()) {
          done(() => resolve(text));
        } else {
          done(() =>
            reject(
              new Error(
                `NVIDIA returned no message content: ${stdout.trim().slice(0, 200)}`
              )
            )
          );
        }
      } catch {
        done(() =>
          reject(
            new Error(
              `NVIDIA response was not JSON: ${stdout.trim().slice(-200) || "(empty body)"}`
            )
          )
        );
      }
    });
  });
}

/**
 * Transport for non-Windows deployments (Railway runs Linux): no curl.exe
 * there and no hostile TLS middlebox — a plain fetch with the exact same
 * non-streaming contract (one JSON body, httpStatus surfaced for
 * friendlyNvidiaError).
 */
async function fetchChatOnce(payload: string): Promise<string> {
  const res = await fetch(`${nvidiaBase()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: payload,
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(
      `NVIDIA chat network failure (HTTP ${res.status}): ${text.slice(0, 200)}`
    );
    (err as any).httpStatus = res.status;
    throw err;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `NVIDIA response was not JSON: ${text.slice(-200) || "(empty body)"}`
    );
  }
  const msg = parsed?.choices?.[0]?.message?.content;
  if (typeof msg === "string" && msg.trim()) return msg;
  throw new Error(`NVIDIA returned no message content: ${text.slice(0, 200)}`);
}

export async function curlChatOnce(payload: string): Promise<string> {
  // Railway/Linux: curl.exe does not exist — use the fetch transport above.
  // The curl.exe + DNS-pin path below stays for the Windows machine the
  // transport note above describes.
  if (process.platform !== "win32") return fetchChatOnce(payload);

  const bodyFile = path.join(
    os.tmpdir(),
    `l2s-chat-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  fs.writeFileSync(bodyFile, payload, "utf8");
  try {
    const url = new URL(`${nvidiaBase()}/chat/completions`);
    const host = url.hostname;
    const port = url.port || "443";
    const ips = await resolveViaPublicDns(host);

    // Attempt strategy (learned the hard way on this machine): the WINDOWS
    // system resolver and the public-DNS edge IPs are BOTH intermittently
    // wrong — the router's resolver may SERVFAIL or return bogus A-records,
    // and a public-DNS pin can route to an edge that ACCEPTS the TLS handshake
    // but never answers the request (curl can't skip an established-but-hung
    // connection, so one dead edge used to eat the whole -m budget). Fix: try
    // candidates in order with a SHORT per-attempt cap and move on:
    //   1. no pin at all (curl uses the system resolver) — has been the only
    //      working path on recent network phases,
    //   2. pins to the public-DNS IPs.
    // An authoritative HTTP answer (4xx/5xx from NVIDIA itself) short-circuits
    // immediately — another edge can't fix a model/account error.
    const candidates: string[][] = []; // list of --resolve arrays
    candidates.push([]); // system resolver
    for (const ip of ips.slice(0, 3)) {
      candidates.push(["--resolve", `${host}:${port}:${ip}`]);
    }
    // SNI/Host stay the real hostname, so TLS validation is unaffected by pins.

    let lastErr: Error | null = null;
    for (const resolveArgs of candidates) {
      try {
        return await curlOnce(bodyFile, url.toString(), resolveArgs, 40);
      } catch (err: any) {
        lastErr = err;
        const raw = String(err?.message ?? err);
        const status = Number(err?.httpStatus ?? 0);
        const isHttpError = /exit 22\b/.test(raw);
        if (isHttpError) {
          // 4xx (except 408/429) = NVIDIA answered authoritatively (bad model,
          // no access, bad request…) — another edge cannot help. 5xx (and
          // 408/429) are edge/overload blips: a different edge or a retry a
          // few seconds later genuinely succeeds, so keep trying candidates.
          if (status >= 400 && status < 500 && status !== 408 && status !== 429) break;
        }
        // otherwise (timeout / connect / DNS / 5xx) fall through to the next candidate
      }
    }
    throw lastErr ?? new Error("NVIDIA chat request failed (no attempts made)");
  } finally {
    try {
      fs.unlinkSync(bodyFile);
    } catch {
      /* temp file best-effort */
    }
  }
}

async function chatCompletion(
  messages: { role: string; content: string }[],
  temperature: number
): Promise<string> {
  const payload = JSON.stringify({
    model: CHAT_MODEL,
    temperature,
    messages,
    // NON-STREAMING (see curlChatOnce): this machine's middlebox swallows
    // SSE response streams specifically; stream:false succeeds reliably.
    stream: false,
    // Repurpose replies (rewritten text for 1-3 platforms) fit well under
    // this; bounding it stops a runaway generation.
    max_tokens: 1200,
  });
  try {
    return await withRetry(() => curlChatOnce(payload), 3);
  } catch (err: any) {
    throw friendlyNvidiaError(err);
  }
}

/**
 * The user's network intermittently enters a "black hole" phase against
 * NVIDIA's edge: TCP + TLS + the full request go through, then zero response
 * bytes arrive (verified 2026-09-03 with verbose curl traces — including from
 * a bare shell with a pinned IP, so it is NOT an app bug). The phase passes
 * after a few minutes. Translate that specific signature into a message the
 * user can act on instead of a cryptic curl exit code.
 */
function friendlyNvidiaError(err: unknown): Error {
  const raw = String((err as any)?.message ?? err);
  const status = Number((err as any)?.httpStatus ?? 0);
  if (status >= 500) {
    return new Error(
      `The AI service (NVIDIA) had a temporary server problem (HTTP ${status}) ` +
        "while answering. Their edges recover on their own within a couple of " +
        "minutes — send your message again shortly. — " +
        raw
    );
  }
  const isStall =
    /exit 28|Operation timed out|timed out|empty reply|not JSON|no message content|0 bytes/i.test(
      raw
    );
  if (isStall) {
    return new Error(
      "The AI service (NVIDIA) is unreachable from your network right now — " +
        "connections open but no data comes back. This is a temporary phase of " +
        "your router/ISP (not a bug in the app) and it has consistently passed " +
        "after a few minutes: wait a moment and send your message again. — " +
        raw
    );
  }
  return new Error(raw);
}


export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

/** Live channel directory so the model never invents channel ids. */
async function channelDirectory(): Promise<string> {
  const accounts = await listAccounts();
  const lines: string[] = [];
  for (const acc of accounts) {
    try {
      const channels = await listChannels(acc.accessToken, acc.organizationId);
      lines.push(`Account "${acc.name}":`);
      for (const ch of channels) {
        lines.push(`  - [${ch.service}] ${ch.displayName} — channelId: ${ch.id}`);
      }
    } catch (err: any) {
      lines.push(`Account "${acc.name}": UNAVAILABLE (${err.message ?? err})`);
    }
  }
  return lines.join("\n") || "(no Buffer accounts configured)";
}

/** Directory from the CLIENT's live page state (no extra Buffer round-trip). */
function directoryFromContext(ctx: ChatPageContext | null | undefined): string {
  const accounts = ctx?.accounts ?? [];
  if (!accounts.length) return "(no Buffer accounts configured)";
  const lines: string[] = [];
  for (const acc of accounts) {
    const channels = acc.channels ?? [];
    if (!channels.length) {
      lines.push(`Account "${acc.accountName ?? acc.accountId}": no channels`);
      continue;
    }
    lines.push(`Account "${acc.accountName ?? acc.accountId}":`);
    for (const ch of channels) {
      lines.push(
        `  - [${ch.service ?? "?"}] ${ch.displayName ?? ch.channelId} — target key: ${acc.accountId}:${ch.channelId}`
      );
    }
  }
  return lines.join("\n");
}

/** What automations exist right now (so the model knows what is already armed). */
function automationSnapshot(): string {
  const tasks = listTasks();
  if (!tasks.length) return "Automations: none scheduled yet.";
  const lines = tasks.map((t) => {
    const tr = t.trigger;
    const trig =
      tr.kind === "interval"
        ? `every ${tr.intervalSec}s`
        : tr.kind === "daily"
          ? `daily at ${tr.atTime} local`
          : `once at ${tr.runAt}`;
    return `  - "${t.name}" [${t.id}] — ${trig} → ${t.action.action} ${JSON.stringify(t.action.params ?? {})} — ${t.enabled ? "ACTIVE" : "paused"}, runs: ${t.runCount}${t.lastError ? `, last error: ${String(t.lastError).slice(0, 100)}` : ""}`;
  });
  return `Scheduled automations (they fire WITHOUT any human):\n${lines.join("\n")}`;
}

/** Readable snapshot of what is loaded on the page right now. */
function buildPageSnapshot(ctx: ChatPageContext | null | undefined): string {
  if (!ctx) return "(no page state shared yet)";
  const parts: string[] = [];

  const v = ctx.video;
  parts.push(
    v
      ? `Video loaded: "${v.title ?? "untitled"}" — ${Math.round(v.durationSec ?? 0)}s, transcript words: ${v.transcriptWords ?? 0}, source: ${v.sourceUrl ? v.sourceUrl.slice(0, 80) : "(stored file)"}, video file on disk: ${v.hasFile ? "yes" : "no (downloaded at render)"}`
      : "No video loaded yet."
  );

  const rules = ctx.rules;
  parts.push(
    `Current editing rules: ${rules?.targetClipCount ?? 3} clips of ${rules?.minClipSec ?? 20}-${rules?.maxClipSec ?? 60}s for ${(rules?.targetPlatforms ?? ["tiktok", "instagram_reels", "youtube_shorts"]).join(", ")}. Instructions: "${rules?.instructions ?? "(default)"}"`
  );
  parts.push(`Style profile loaded: ${ctx.styleProfileLoaded ? "yes" : "no"}`);

  const plan = ctx.editPlan;
  const clips = plan?.clips ?? [];
  if (clips.length) {
    parts.push(`Edit plan: ${clips.length} clips.`);
    clips.forEach((c) => {
      const rendered = plan?.rendered?.[c.clipIndex] ? "RENDERED" : "not rendered";
      const cap = plan?.captionsDrafted?.[c.clipIndex] ? "caption drafted" : "no caption";
      parts.push(
        `  Clip ${c.clipIndex}: "${c.hookTitle ?? c.clipId ?? "untitled"}" (${Math.round(c.startSec ?? 0)}-${Math.round(c.endSec ?? 0)}s) — ${rendered}, ${cap}`
      );
    });
  } else {
    parts.push("Edit plan: none yet.");
  }

  const uploads = ctx.storedUploads ?? [];
  parts.push(
    uploads.length
      ? `Stored videos on this machine: ${uploads.map((u) => `"${u}"`).join(", ")}`
      : "Stored videos: none."
  );
  const renders = ctx.renderedFiles ?? [];
  parts.push(
    renders.length
      ? `Rendered clips on disk: ${renders.map((r) => `"${r.file}" (${r.hookTitle ?? ""})`).join(", ")}`
      : "Rendered clips on disk: none."
  );

  const missing = ctx.configMissing ?? [];
  if (missing.length) {
    parts.push(`Warning: these setup keys are missing: ${missing.join(", ")}.`);
  }
  return parts.join("\n");
}

function systemPrompt(directory: string, ctx: ChatPageContext | null | undefined): string {
  return `You are the copilot inside the long2short app — a short-form video studio that turns long videos into 9:16 clips and posts them to Buffer-connected channels. You can DO things on the page (analyze, plan, render, caption, post, research) the same way the buttons do.

LIVE CHANNEL DIRECTORY (the only channel ids that exist; post_to_buffer targets use "accountId:channelId" target keys):
${directory}

WHAT IS ON THE PAGE RIGHT NOW:
${buildPageSnapshot(ctx)}

AUTOMATIONS (things that run on their own):
${automationSnapshot()}

ACTIONS — when the user wants something DONE, answer conversationally FIRST, then append exactly ONE fenced block as the last thing in your reply (EXCEPTION: your plan-only reply described under PLAN FIRST must contain NO action block):
\`\`\`action
{ ...json... }
\`\`\`
${actionCatalogText()}

RULES
- PLAN FIRST — MANDATORY, ALWAYS. Before taking ANY action on a NEW request, your FIRST reply must be a PLAN ONLY: do NOT include an action block in it, and stop. The plan must contain: (1) what you understood they are asking for, restated in your own words; (2) the exact ordered steps you will run (name each action id, e.g. analyze_url → generate_edit_plan → render_clip → post_to_buffer); (3) WHAT IT TAKES — realistic time (renders are ~1–3 min each), how many videos come off their monthly quota when analyze is involved, which channels each post would go to, and anything that costs money (Apify/NVIDIA); (4) anything you STILL NEED from them (exact caption text, which target channels, edit preferences). Then wait. Do not implement until they approve ("ok", "go ahead", "approve", …). Only re-plan if they change the request. This approval step is required even if it seems obvious.
- CAPTIONS: if the user gives you caption/hashtag text to post, use THEIR EXACT WORDS as post_to_buffer's caption — never rewrite, shorten or "improve" it unless they explicitly ask. If they only describe the vibe ("make it punchy"), you write it yourself (use draft_caption first if they want to review before posting).
- EDIT PREFERENCES: whenever the user states how they want the edit (pacing, hook style, clip length or count, what to cut or keep, zoom style, tone, on-screen text), pass those words VERBATIM as generate_edit_plan's instructions param. Remember them for later steps too (captions, drafts) so the whole pipeline follows their taste.
- You NEVER execute anything yourself. For any real-world effect emit the action block and it runs automatically (or waits for the user's Confirm when marked requires CONFIRM) — but only AFTER the plan approval above.
- After a step completes you will receive a new user message starting with "⚙ Step complete" containing the outcome. Then CONTINUE the pipeline until the user's request is fully done, then summarize concisely.
- Prefer the user's loaded video. If no video is loaded and the user gives a link, use analyze_url first. If the user only says "analyze this video", that alone is fine.
- generate_edit_plan runs the AI editor on the loaded video. Optional params: clipCount, minSec, maxSec, targetPlatforms, instructions (extra focus). Use the page's current rules unless the user asks for different numbers.
- Only propose render_clip when the edit plan exists. Only propose post_to_buffer when the target clip is RENDERED (see "not rendered" above). Never invent channel target keys.
- For posting captions, write ready-to-publish text for the target platform (length limits, tone, hashtags) — UNLESS the user dictated the caption, in which case use theirs verbatim (see CAPTIONS above).
- draft_caption writes the caption into the page for that clip; brief is optional wording guidance.
- AUTOMATIONS: when the user wants something to happen REPEATEDLY or LATER without them ("every day at 9am", "in 2 hours", "whenever..."), use schedule_create. The repeat action goes inside "actionData" ({"actionData":{"action":"<executor id>","params":{...}}}). Triggers: {"kind":"interval","intervalSec":N} (min 60), {"kind":"daily","atTime":"HH:MM"} (24h local), {"kind":"once","runAt":"<ISO datetime>"}. The scheduled action runs unattended — still fill in ALL required params (channels, caption, clipIndex…) exactly as a normal action needs. Confirm with the user before automating post_to_buffer. Afterwards tell the user it will fire on its own; schedule_list/schedule_history show what is armed and what happened.
- Keep replies short and concrete. Cite clip numbers ("Clip 0") consistently (0-based).`;
}

export async function runChat(
  history: ChatMsg[],
  context?: ChatPageContext | null
): Promise<string> {
  ensureScheduler(); // keep the automation timer alive whenever the copilot is used
  const directory = context?.accounts?.length
    ? directoryFromContext(context)
    : await channelDirectory();
  return chatCompletion(
    [
      { role: "system", content: systemPrompt(directory, context ?? null) },
      ...history.slice(-20),
    ],
    0.6
  );
}

/** Pulls the LAST fenced action block out of a reply. */
export function parseAction(reply: string): { clean: string; action: any | null } {
  const re = /```(?:action|json)?\s*\n?([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let found: any = null;
  let block: string | null = null;
  while ((m = re.exec(reply))) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed && typeof parsed.action === "string") {
        found = parsed;
        block = m[0];
      }
    } catch {
      /* not an action block */
    }
  }
  const clean = block ? reply.replace(block, "").trim() : reply.trim();
  return { clean, action: found };
}

/** Confirmed post: resolves each channelId to its owning account and posts. */
export async function executePostAction(action: any) {
  const text = String(action.text ?? "").trim();
  if (!text) throw new Error("The post action has no text to publish.");
  const ids: string[] =
    Array.isArray(action.channelIds) && action.channelIds.length
      ? action.channelIds.map(String)
      : action.channelId
        ? [String(action.channelId)]
        : [];
  if (!ids.length) throw new Error("No channels were selected for this post.");

  const mode = action.mode === "schedule" ? "schedule" : "queue";
  const accounts = await listAccounts();
  const owners = new Map<string, { token: string; label: string }>();
  for (const acc of accounts) {
    try {
      const chans = await listChannels(acc.accessToken, acc.organizationId);
      for (const ch of chans) {
        if (ids.includes(ch.id)) {
          owners.set(ch.id, {
            token: acc.accessToken,
            label: `${ch.displayName} [${ch.service}]`,
          });
        }
      }
    } catch {
      /* account unreachable — its channels simply won't match */
    }
  }

  const results = await Promise.all(
    ids.map(async (id) => {
      const owner = owners.get(id);
      if (!owner) {
        return { channelId: id, ok: false, error: "no saved account owns this channelId" };
      }
      try {
        const post = await createPost(
          {
            channelId: id,
            text,
            mode,
            videoUrl: action.videoUrl || undefined,
            dueAtIso: action.dueAtIso || undefined,
          },
          owner.token
        );
        return { channelId: id, channel: owner.label, ok: true, postId: post?.id, dueAt: post?.dueAt };
      } catch (err: any) {
        return { channelId: id, channel: owner.label, ok: false, error: err.message ?? String(err) };
      }
    })
  );
  return { kind: "post", results };
}

const PLATFORM_STYLE: Record<string, string> = {
  twitter: "X/Twitter: hard max 280 chars, ONE sharp idea, no hashtag spam, punchy line breaks.",
  tiktok: "TikTok caption: 5-word hook first, casual voice, 3-5 trending-style hashtags.",
  instagram: "Instagram: emoji-rich, short lines, 5-10 hashtags at the end, save/share CTA.",
  facebook: "Facebook: conversational 2-4 sentences, link-friendly, max 1-2 hashtags.",
  youtube: "YouTube: title-style text, max 90 chars, keywords front-loaded.",
  dailymotion: "Dailymotion: concise descriptive title plus one sentence.",
};

/** Confirmed repurpose: fetch the original post, rewrite per target platform. */
export async function executeRepurposeAction(action: any) {
  const postUrl = String(action.postUrl ?? "");
  const targets: string[] =
    Array.isArray(action.targets) && action.targets.length
      ? action.targets.map(String)
      : ["twitter", "tiktok", "instagram"];
  const fetched = await fetchPostContent(postUrl);

  const raw = (
    await chatCompletion(
      [
        {
          role: "system",
          content:
            'You repurpose social posts for other platforms. Reply ONLY with JSON: {"drafts":[{"platform":"<target>","text":"<ready to publish>"}]} — one draft per requested target, same order.',
        },
        {
          role: "user",
          content: JSON.stringify({
            originalPlatform: fetched.platform,
            author: fetched.author ?? null,
            originalText: fetched.text,
            targets,
            styleGuide: PLATFORM_STYLE,
          }),
        },
      ],
      0.7
    )
  )
    .replace(/```json|```/g, "")
    .trim();
  let drafts: any[] = [];
  try {
    const parsed = JSON.parse(raw);
    drafts = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.drafts) ? parsed.drafts : [];
  } catch {
    throw new Error("The model returned malformed drafts — try again.");
  }
  return {
    kind: "repurpose",
    source: {
      platform: fetched.platform,
      url: fetched.url,
      via: fetched.via,
      author: fetched.author ?? null,
    },
    drafts: drafts.map((d) => ({
      platform: String(d.platform ?? "?"),
      text: String(d.text ?? ""),
    })),
  };
}
