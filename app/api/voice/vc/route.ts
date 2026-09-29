import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { forwardToVoice } from "../../../../lib/voiceServer";

// Voice conversion — re-voice any uploaded audio with a target voice clip
// using the Chatterbox VC model. Same forwarding pattern as /api/voice/tts.
export const runtime = "nodejs";
export const maxDuration = 900;

const VOICE_OUT_DIR = path.join(process.cwd(), "public", "voice");

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const audio = form.get("audio");
    if (!audio || typeof audio === "string") {
      return NextResponse.json({ error: "Upload an audio file to convert first." }, { status: 400 });
    }

    const upstream = await forwardToVoice("/vc", form);
    const ctype = upstream.headers.get("content-type") ?? "";

    if (!upstream.ok || !ctype.includes("audio")) {
      let message = `Voice server error (HTTP ${upstream.status}).`;
      try {
        const body = await upstream.json();
        if (body?.error) message = body.error;
      } catch {
        /* non-JSON error body — keep default message */
      }
      return NextResponse.json({ error: message }, { status: upstream.status === 503 ? 503 : 502 });
    }

    fs.mkdirSync(VOICE_OUT_DIR, { recursive: true });
    const fileName = `vc-${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
    const filePath = path.join(VOICE_OUT_DIR, fileName);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    const sr = Number(upstream.headers.get("X-Audio-Sr") ?? 0);
    const duration = Number(upstream.headers.get("X-Audio-Duration") ?? 0);
    return NextResponse.json({
      url: `/voice/${fileName}`,
      file: fileName,
      sizeMb: Math.round((buffer.length / 1024 / 1024) * 100) / 100,
      sr,
      duration,
      model: "vc",
      created: fs.statSync(filePath).mtime,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Voice conversion failed. Is the voice server installed & running?" },
      { status: 502 }
    );
  }
}