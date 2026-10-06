import { NextRequest, NextResponse } from "next/server";
import {
  executePostAction,
  executeRepurposeAction,
} from "../../../../lib/chat";
import {
  executeChatAction,
  actionLabel,
  summarizeOutcome,
  type ActionOutcome,
} from "../../../../lib/actions";

export const runtime = "nodejs";
export const maxDuration = 300; // repurpose can fetch via Apify + rewrite

/**
 * Executes a chat-confirmed action. The chat route NEVER executes anything —
 * it only proposes; the user must hit Confirm in the UI (or the client
 * auto-runs safe actions), which lands here.
 */
export async function POST(req: NextRequest) {
  try {
    const { action } = await req.json();
    if (!action || typeof action !== "object") {
      return NextResponse.json({ error: "action object is required" }, { status: 400 });
    }

    const kind = String(action.action ?? "");

    // Legacy (pre-copilot) actions keep working unchanged.
    if (kind === "post") {
      const result = await executePostAction(action);
      return NextResponse.json({ result });
    }
    if (kind === "repurpose") {
      if (!action.postUrl) {
        return NextResponse.json({ error: "postUrl is required" }, { status: 400 });
      }
      const result = await executeRepurposeAction(action);
      return NextResponse.json({ result });
    }

    // New-style copilot actions — same server logic as the page buttons
    // (lib/actions.ts). Returns the result, a statePatch the page UI applies,
    // and a one-line summary used to continue the conversation.
    let outcome: ActionOutcome;
    try {
      outcome = await executeChatAction(kind, action);
    } catch (err: any) {
      return NextResponse.json(
        { error: err.message ?? `${kind} failed` },
        { status: err?.status ?? 500 }
      );
    }
    return NextResponse.json({
      result: outcome.result,
      statePatch: outcome.statePatch,
      action,
      summary: summarizeOutcome(kind, outcome),
      label: actionLabel(kind),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "action failed" }, { status: 500 });
  }
}