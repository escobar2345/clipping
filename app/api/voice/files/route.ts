import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

// Lists (and deletes) generated voice files stored in public/voice so the
// Voice Studio can show a history of your voice-overs / conversions.
export const runtime = "nodejs";
export const maxDuration = 30;
// Never pre-render at build time — the file list changes as users generate audio.
export const dynamic = "force-dynamic";

const VOICE_OUT_DIR = path.join(process.cwd(), "public", "voice");

type VoiceFile = {
  file: string;
  url: string;
  sizeMb: number;
  modified: string;
  kind: "tts" | "vc";
};

function listVoiceFiles(): VoiceFile[] {
  fs.mkdirSync(VOICE_OUT_DIR, { recursive: true });
  return fs
    .readdirSync(VOICE_OUT_DIR)
    .filter((f) => f.endsWith(".wav"))
    .map((f) => {
      const p = path.join(VOICE_OUT_DIR, f);
      const st = fs.statSync(p);
      return {
        file: f,
        url: `/voice/${f}`,
        sizeMb: Math.round((st.size / 1024 / 1024) * 100) / 100,
        modified: st.mtime.toISOString(),
        kind: f.startsWith("vc-") ? ("vc" as const) : ("tts" as const),
      };
    })
    .sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

export async function GET() {
  return NextResponse.json({ files: listVoiceFiles() });
}

export async function DELETE(req: NextRequest) {
  try {
    const { file } = (await req.json()) as { file?: string };
    if (!file || file.includes("..") || !/^[a-zA-Z0-9._-]+\.wav$/.test(file)) {
      return NextResponse.json({ error: "Invalid file name." }, { status: 400 });
    }
    const p = path.join(VOICE_OUT_DIR, file);
    if (!fs.existsSync(p)) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }
    fs.unlinkSync(p);
    return NextResponse.json({ ok: true, files: listVoiceFiles() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Delete failed." }, { status: 500 });
  }
}