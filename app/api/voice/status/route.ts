import { NextResponse } from "next/server";
import { ensureVoiceServer } from "../../../../lib/voiceServer";
import { withAuth } from "../../../../lib/withAuth";

// Status of the Voice Studio Python bridge (chatterbox). Reported to the UI
// so it can show setup guidance before the user tries to generate anything.
export const runtime = "nodejs";
export const maxDuration = 30;
// Never pre-render this at build time — the bridge state changes at runtime.
export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  try {
    const health = await ensureVoiceServer();
    return NextResponse.json({ status: health.ready ? "ready" : "not-ready", ...health });
  } catch (e: any) {
    return NextResponse.json(
      { status: "unavailable", error: e?.message ?? String(e) },
      { status: 200 }
    );
  }
});