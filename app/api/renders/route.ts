import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { withAuth } from "../../../lib/withAuth";
import { rendersDir, rendersUrlPath } from "../../../lib/userPaths";

export const runtime = "nodejs";
// Reads public/renders live — never serve a cached/prerendered copy.
export const dynamic = "force-dynamic";

// Bare filenames only — blocks path traversal like "../package.json".
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

type ManifestEntry = {
  file: string;
  sourceUrl?: string;
  sourceFile?: string;
  sourceStartSec?: number;
  sourceEndSec?: number;
  hookTitle?: string;
  renderedAt?: string;
};

/**
 * Lists clips already rendered by THIS user (public/renders/<userId>/), with
 * provenance from their own manifest.json (written by /api/render) so the UI can
 * show preview players WITHOUT re-running the expensive Remotion render.
 * Read-only — nothing here touches Buffer.
 */
export const GET = withAuth(async () => {
  const dir = rendersDir();

  let manifestEntries: ManifestEntry[] = [];
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, "manifest.json"), "utf8")
    );
    if (Array.isArray(parsed.renders)) manifestEntries = parsed.renders;
  } catch {
    /* no manifest yet — fall back to bare listing */
  }
  const byFile = new Map(manifestEntries.map((m) => [m.file, m]));

  let renders: Record<string, any>[] = [];
  try {
    renders = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".mp4"))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        const meta = byFile.get(f);
        return {
          file: f,
          url: rendersUrlPath(f),
          sizeMb: +(st.size / 1024 / 1024).toFixed(1),
          modified: st.mtime.toISOString(),
          sourceUrl: meta?.sourceUrl ?? null,
          sourceFile: meta?.sourceFile ?? null,
          sourceStartSec: meta?.sourceStartSec ?? null,
          sourceEndSec: meta?.sourceEndSec ?? null,
          hookTitle: meta?.hookTitle ?? null,
        };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    /* renders dir doesn't exist yet */
  }

  return NextResponse.json({ renders });
});

/**
 * Deletes ONE rendered clip from public/renders and drops its provenance
 * entry from manifest.json, so the gallery and the "already rendered"
 * hydration never point at a ghost file. Buffer is NOT notified — a clip
 * that's queued/scheduled there has usually already been fetched by Buffer's
 * servers at publish time, but a still-pending scheduled post that points at
 * this file will fail. The UI warns about exactly that before calling this.
 * Body: { file: "clip-1.mp4" }
 */
export const DELETE = withAuth(async (req: Request) => {
  try {
    const { file } = (await req.json()) as { file?: string };
    if (
      !file ||
      file !== path.basename(file) ||
      !SAFE_FILENAME.test(file) ||
      !file.toLowerCase().endsWith(".mp4")
    ) {
      return NextResponse.json({ error: "Invalid file name" }, { status: 400 });
    }

    // The signed-in user's own render folder — never another account's.
    const dir = rendersDir();
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) {
      return NextResponse.json(
        { error: `No rendered clip named ${file} exists` },
        { status: 404 }
      );
    }
    fs.unlinkSync(target);

    // Keep manifest.json in sync — a stale entry would make the UI think a
    // clip still exists for this source video.
    const manifestPath = path.join(dir, "manifest.json");
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (Array.isArray(parsed.renders)) {
        fs.writeFileSync(
          manifestPath,
          JSON.stringify(
            { renders: parsed.renders.filter((r: any) => r.file !== file) },
            null,
            2
          )
        );
      }
    } catch {
      /* no manifest yet — nothing to sync */
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Delete failed" }, { status: 500 });
  }
});