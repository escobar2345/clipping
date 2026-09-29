import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { forwardToVoice } from "../../../../lib/voiceServer";

// Voice-over + voice cloning endpoint. Receives the same multipart fields the
// Python bridge expects (text, model, language, params, optional voice_ref),
// forwards them, and stores the returned .wav in public/voice so the browser
// can play it. Gen + one-time model download can take minutes.
export const runtime = "nodejs";
export const maxDuration = 900;

const VOICE_OUT_DIR = path.join(process.cwd(), "public", "voice");

function audioHeaders(upstream: Response) {
  return {
    sr: Number(upstream.headers.get("X-Audio-Sr") ?? 0),
    duration: Number(upstream.headers.get("X-Audio-Duration") ?? 0),
    model: upstream.headers.get("X-Model") ?? "",
  };
}

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();

    if (!form.get("text") || !String(form.get("text") ?? "").trim()) {
      return NextResponse.json({ error: "Enter some text to synthesize first." }, { status: 400 });
    }

    const upstream = await forwardToVoice("/tts", form);
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
    const fileName = `tts-${Date.now()}-${randomUUID().slice(0, 8)}.wav`;
    const filePath = path.join(VOICE_OUT_DIR, fileName);
    const buffer = Buffer.from(await upstream.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    const meta = audioHeaders(upstream);
    const created = fs.statSync(filePath).mtime;
    return NextResponse.json({
      url: `/voice/${fileName}`,
      file: fileName,
      sizeMb: Math.round((buffer.length / 1024 / 1024) * 100) / 100,
      sr: meta.sr,
      duration: meta.duration,
      model: meta.model,
      created,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Voice synthesis failed. Is the voice server installed & running?" },
      { status: 502 }
    );
  }
}