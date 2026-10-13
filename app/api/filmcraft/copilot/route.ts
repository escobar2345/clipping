import { NextResponse } from "next/server";
import OpenAI from "openai";
import { withAuth } from "../../../../lib/withAuth";

export const runtime = "nodejs";
export const maxDuration = 120;

// Same NVIDIA OpenAI-compatible endpoint + model the rest of the app uses (see
// lib/nvidiaGlm.ts). Non-streaming, proven transport.
const MODEL = process.env.NVIDIA_GLM_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b";

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY,
      baseURL: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      timeout: 180_000,
      maxRetries: 0,
    });
  }
  return _client;
}

/**
 * The AI drives the REAL FilmCraft editor through its `window.filmcraft`
 * agent API. The client sends the LIVE project state (`inspect()`), the
 * imported media (`files()`), and — crucially — the live command catalog
 * (`commands()`) so the model only ever emits commands that actually exist.
 * It replies with an ordered list of { command, params, description } that
 * the browser executes one-by-one via filmcraft.execute(), so the user watches
 * the edit happen step by step.
 */
const SYSTEM = `You are the AI Co-Pilot inside FilmCraft, a professional non-linear video editor. You drive the editor DIRECTLY through its command API. The user gives an instruction (typed or spoken); you turn it into an ordered list of concrete editor commands.

You are given:
- context.inspect : the current project/UI state (timeline, playhead, selection, tracks, clips).
- context.files   : the imported media (name, duration, path, whether it has audio).
- context.commands: the LIVE FilmCraft command catalog. Each entry has a command id and the params it accepts.
- context.transcript (optional): a transcript of the clip's spoken audio, if the user has transcribed it. Use it to cut on words, add titles, place captions, etc.

Respond ONLY with JSON, no prose outside it:
{
  "reply": "<one or two short sentences saying what you will do / did>",
  "steps": [ { "command": "<exact id from context.commands>", "params": { ...matching that command's params... }, "description": "<plain-English label for this single step, e.g. 'Split the clip at the playhead'>" } ]
}

STRICT RULES:
- Use ONLY command ids that appear in context.commands. NEVER invent a command. If no command fits, put the reason in "reply" and return an empty "steps".
- Keep each step to a SINGLE editor action so the user can follow it. Break a big request into small ordered steps (e.g. "make a 10s highlight with a title" = split -> trim -> add title -> ...). Prefer more small steps over one big vague step.
- Fill "params" to match exactly what the command expects; look at each command's declared params. Omit params the command does not define.
- For times, use the current playhead/selection from context.inspect when the user says "here"/"this"/"at the playhead"; otherwise use times from context.inspect/context.files.
- Reference real clip/asset ids from the state — never invent ids.
- Always include a non-empty "reply". Do the smallest set of steps that fulfils the request.`;

interface CopilotStep {
  command: string;
  params: Record<string, unknown>;
  description?: string;
}

function parseCopilot(raw: string): { reply: string; steps: CopilotStep[] } {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const normalize = (obj: any): CopilotStep[] =>
    Array.isArray(obj?.steps)
      ? (obj.steps as CopilotStep[])
          .filter((s) => s && typeof s.command === "string")
          .map((s) => ({
            command: String(s.command),
            params: s.params && typeof s.params === "object" ? s.params : {},
            description: typeof s.description === "string" ? s.description : undefined,
          }))
      : [];
  try {
    const obj = JSON.parse(cleaned);
    return { reply: typeof obj.reply === "string" ? obj.reply : "", steps: normalize(obj) };
  } catch {
    // Model occasionally wraps JSON in prose — salvage the first {...} block.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        return {
          reply: typeof obj.reply === "string" ? obj.reply : "",
          steps: normalize(obj),
        };
      } catch {
        /* fall through */
      }
    }
    return { reply: cleaned || "(no reply)", steps: [] };
  }
}

/**
 * The client ships the LIVE command catalog (`context.commands`), which can be
 * very large — every command plus its full param schema. POSTing that whole to
 * NVIDIA risks a connection reset that surfaces as the SDK's generic
 * "Connection error." Reduce it to just the command id + its param names, and
 * keep the project state, so the model still only ever emits real command ids.
 */
function compactContext(ctx: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!ctx) return out;
  if (ctx.inspect) out.inspect = ctx.inspect;
  if (ctx.files) out.files = ctx.files;
  if (ctx.transcript) out.transcript = ctx.transcript;
  const cmds = Array.isArray(ctx.commands) ? ctx.commands : [];
  out.commands = cmds
    .slice(0, 400)
    .map((c: any) => {
      const params = c?.params ?? c?.parameters ?? c?.args;
      return {
        id: c?.id ?? c?.command ?? c?.name ?? "",
        params: Array.isArray(params)
          ? params
              .map((p: any) => (typeof p === "string" ? p : p?.name ?? p?.id ?? ""))
              .filter(Boolean)
          : typeof params === "object" && params
          ? Object.keys(params)
          : [],
      };
    })
    .filter((c: any) => c.id);
  return out;
}

/**
 * Build the user message JSON with a hard size cap so we never send a giant
 * body. If it's too big we shed the bulkiest optional fields (transcript, then
 * the command list) — always producing VALID JSON, never a truncated string.
 */
function buildUserContent(
  instruction: string,
  history: unknown[] | undefined,
  ctx: Record<string, unknown> | undefined
): string {
  const base = { instruction, history: (history ?? []).slice(-12) as unknown[] };
  const context = compactContext(ctx);
  let s = JSON.stringify({ ...base, context });
  if (s.length > 24000 && context.transcript) {
    delete context.transcript;
    s = JSON.stringify({ ...base, context });
  }
  if (s.length > 24000 && Array.isArray(context.commands) && context.commands.length) {
    context.commands = (context.commands as any[]).map((c: any) => c.id);
    s = JSON.stringify({ ...base, context });
  }
  return s;
}

export const POST = withAuth(
  async (req: Request) => {
    try {
      if (!process.env.NVIDIA_API_KEY) {
        return NextResponse.json(
          {
            error:
              "NVIDIA_API_KEY is not set — add it to .env.local (get one at build.nvidia.com) so the FilmCraft Co-Pilot can run.",
          },
          { status: 500 }
        );
      }

      const body = (await req.json()) as {
        instruction?: string;
        history?: { role: string; content: string }[];
        context?: Record<string, unknown>;
      };
      if (!body?.instruction?.trim()) {
        return NextResponse.json({ error: "instruction is required" }, { status: 400 });
      }

      const completion = await client().chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM },
          {
            role: "user",
            content: buildUserContent(body.instruction, body.history, body.context),
          },
        ],
      });

      const raw = completion.choices[0]?.message?.content ?? "";
      const { reply, steps } = parseCopilot(raw);
      return NextResponse.json({ reply, steps });
    } catch (err: any) {
      return NextResponse.json({ error: err?.message ?? "Co-Pilot request failed" }, { status: 500 });
    }
  },
  // The Co-Pilot spends the user's NVIDIA quota on every message.
  { plan: "paid" }
);
