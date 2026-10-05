import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { withAuth } from "../../../../lib/withAuth";
import { voiceDir, voiceUrlPath } from "../../../../lib/userPaths";

// Lists (and deletes) generated voice files stored in public/voice/<userId>/ so
// the Voice Studio can show a history of THIS user's voice-overs / conversions.
export const runtime = "nodejs";
export const maxDuration = 30;
// Never pre-render at build time — the file list changes as users generate audio.
export const dynamic = "force-dynamic";

type VoiceFile = {
  file: string;
  url: string;
  sizeMb: number;
  modified: string;
  kind: "tts" | "vc";
};

function listVoiceFiles(): VoiceFile[] {
  // Resolved per request from the signed-in user.
  const dir = voiceDir();
  fs.mkdirSync(dir, { recursive: true });
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".wav"))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return {
        file: f,
        url: voiceUrlPath(f),
        sizeMb: Math.round((st.size / 1024 / 1024) * 100) / 100,
        modified: st.mtime.toISOString(),
        kind: f.startsWith("vc-") ? ("vc" as const) : ("tts" as const),
      };
    })
    .sort((a, b) => (a.modified < b.modified ? 1 : -1));
}

export const GET = withAuth(async () => {
  return NextResponse.json({ files: listVoiceFiles() });
});

export const DELETE = withAuth(async (req: Request) => {
  try {
    const { file } = (await req.json()) as { file?: string };
    if (!file || file.includes("..") || !/^[a-zA-Z0-9._-]+\.wav$/.test(file)) {
      return NextResponse.json({ error: "Invalid file name." }, { status: 400 });
    }
    // voiceDir() is this user's own folder.
    const p = path.join(voiceDir(), file);
    if (!fs.existsSync(p)) {
      return NextResponse.json({ error: "File not found." }, { status: 404 });
    }
    fs.unlinkSync(p);
    return NextResponse.json({ ok: true, files: listVoiceFiles() });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Delete failed." }, { status: 500 });
  }
});