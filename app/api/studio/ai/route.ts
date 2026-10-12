import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import type { StudioAIRequest, StudioAction } from "../../../../lib/studioTypes";

export const runtime = "nodejs";
export const maxDuration = 120;

// Same OpenAI-compatible NVIDIA endpoint the rest of the app uses (see
// lib/nvidiaGlm.ts). Non-streaming, exactly like the edit-plan path — that
// transport is the one proven to work on this machine.
const MODEL = process.env.NVIDIA_CHAT_MODEL ?? "z-ai/glm-5.3";

let _client: OpenAI | null = null;
function client(): OpenAI {
  if (!_client) {
    _client = new OpenAI({
      apiKey: process.env.NVIDIA_API_KEY,
      baseURL: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
      timeout: 120_000,
      maxRetries: 1,
    });
  }
  return _client;
}

const SYSTEM = `You are the AI editor inside "Editing Studio", a Premiere-Pro-style video editor embedded in the user's app. You have FULL control of the user's timeline. Convert their instruction (typed or spoken) into concrete edit actions.

Respond ONLY with JSON, no prose outside it:
{"reply":"<one short sentence describing what you did>","actions":[ ...ordered actions... ]}

Available actions (apply in order):
- {"op":"addMedia","mediaId":"<id>","at":<optional 0-based index>}  put a bin clip on the timeline (omit "at" to append)
- {"op":"split","atSec":<timeline seconds>}  cut whatever clip spans that time into two pieces
- {"op":"trim","clipId":"<id>","srcStart":<sec>,"srcEnd":<sec>}  set a clip's in/out points (source time)
- {"op":"setSpeed","clipId":"<id>","speed":<0.5..2>}
- {"op":"setVolume","clipId":"<id>","volume":<0..2>}
- {"op":"setText","clipId":"<id>","text":"<overlay title>"}
- {"op":"setTransition","clipId":"<id>","transition":"none"|"fade"|"dissolve"}
- {"op":"removeClip","clipId":"<id>"}
- {"op":"moveClip","clipId":"<id>","toIndex":<0-based>}
- {"op":"clearTimeline"}
- {"op":"setPlayhead","atSec":<sec>}

Rules:
- Only reference mediaId values present in context.media and clipId values present in context.timeline.clips. NEVER invent ids; if you need an id you don't have, ask or use addMedia with a real mediaId.
- Times are seconds. srcStart/srcEnd are inside one source clip; srcEnd must be greater than srcStart. timeline clip order is the playback order.
- If the request cannot be done with the actions above, reply in words and return an empty actions array.
- Do the smallest set of actions that fulfils the request. Always include a non-empty "reply".`;

function parseAI(raw: string): { reply: string; actions: StudioAction[] } {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  try {
    const obj = JSON.parse(cleaned);
    return {
      reply: typeof obj.reply === "string" ? obj.reply : "",
      actions: Array.isArray(obj.actions) ? (obj.actions as StudioAction[]) : [],
    };
  } catch {
    return { reply: cleaned || "(no reply)", actions: [] };
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.NVIDIA_API_KEY) {
      return NextResponse.json(
        {
          error:
            "NVIDIA_API_KEY is not set — add it to .env.local (get one at build.nvidia.com) so the studio AI can run.",
        },
        { status: 500 }
      );
    }

    const body = (await req.json()) as StudioAIRequest;
    if (!body?.instruction?.trim()) {
      return NextResponse.json({ error: "instruction is required" }, { status: 400 });
    }

    const completion = await client().chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      messages: [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            instruction: body.instruction,
            history: body.history ?? [],
            context: body.context,
          }),
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "";
    const { reply, actions } = parseAI(raw);
    return NextResponse.json({ reply, actions });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message ?? "AI request failed" }, { status: 500 });
  }
}
