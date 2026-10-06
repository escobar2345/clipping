import { NextRequest, NextResponse } from "next/server";
import { runChat, parseAction } from "../../../lib/chat";
import { actionNeedsConfirm, actionLabel, type ChatPageContext } from "../../../lib/actions";

export const runtime = "nodejs";
// Streaming keeps this bounded in practice, but a genuinely long generation
// on a slow link can run a few minutes — give it headroom (local dev ignores
// this; it matters when deployed to serverless).
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const { messages, context } = await req.json();
    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages array is required" }, { status: 400 });
    }
    const history = messages
      .filter(
        (m: any) =>
          (m.role === "user" || m.role === "assistant") &&
          typeof m.content === "string" &&
          m.content.trim()
      )
      .map((m: any) => ({ role: m.role, content: m.content }));

    // context = light summary of the page the browser is showing (video loaded,
    // rules, edit plan, channels…) so the model knows exactly what is on screen.
    let ctx: ChatPageContext | null = null;
    if (context && typeof context === "object") ctx = context as ChatPageContext;

    const reply = await runChat(history, ctx);
    const { clean, action } = parseAction(reply);
    const pendingAction = action
      ? {
          ...action,
          // The client shows a Confirm button for these and auto-runs the rest.
          needsConfirm: actionNeedsConfirm(String(action.action ?? "")),
          actionLabel: actionLabel(String(action.action ?? "")),
        }
      : null;
    return NextResponse.json({
      reply: clean || "(empty reply — try again)",
      pendingAction,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "chat failed" }, { status: 500 });
  }
}