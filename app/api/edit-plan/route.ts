import { NextRequest, NextResponse } from "next/server";
import { generateEditPlan } from "../../../lib/nvidiaGlm";
import { buildVisualContext } from "../../../lib/visualScan";
import { ensureTranscript } from "../../../lib/transcript";
import type { VideoIntel, EditRules, StyleProfile } from "../../../lib/types";
import {
  DEFAULT_EDIT_SYSTEM_PROMPT,
  getSavedSystemPrompt,
  saveSystemPrompt,
} from "../../../lib/prompts";

export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const intel = body.intel as VideoIntel;
    const rules = body.rules as EditRules;
    const styleProfile = body.styleProfile as StyleProfile | undefined;

    if (!intel || !rules) {
      return NextResponse.json({ error: "intel and rules are required" }, { status: 400 });
    }

    // The AI's own system prompt is editable from the UI. If the request
    // carries one, persist it (empty string = reset to default). If it sends
    // nothing, fall back to whatever was saved before, else the default.
    let systemPrompt: string;
    if (typeof body.systemPrompt === "string") {
      const sp = body.systemPrompt.trim();
      saveSystemPrompt(sp.length ? sp : null);
      systemPrompt = sp.length ? sp : DEFAULT_EDIT_SYSTEM_PROMPT;
    } else {
      systemPrompt = getSavedSystemPrompt() ?? DEFAULT_EDIT_SYSTEM_PROMPT;
    }

    // Speech-to-text: platform captions when they exist, otherwise Deepgram
    // transcribes the video (uploads / caption-less links). Runs first because
    // it also makes sure the video file is on disk for the visual scan below.
    const transcriptSource = await ensureTranscript(intel);

    // Visual intelligence: exact scene cuts (ffmpeg scans EVERY frame) plus
    // vision-model notes on sampled frames. Best-effort — a failure here only
    // strips the visual-context bonus, it never blocks the edit plan itself.
    let visualContext = null;
    try {
      visualContext = await buildVisualContext(intel);
    } catch {
      visualContext = null;
    }

    const editPlan = await generateEditPlan(
      intel,
      rules,
      styleProfile,
      systemPrompt,
      visualContext
    );
    editPlan.transcriptSource = transcriptSource;
    return NextResponse.json({ editPlan, visualContext, transcriptSource });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Edit plan generation failed" }, { status: 500 });
  }
}
