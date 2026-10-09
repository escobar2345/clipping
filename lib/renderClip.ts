// Shared Remotion render core, used by /api/render AND the chat assistant's
// render_clip action — one code path so a clip renders identically whether the
// user clicks the button or tells the chat to render it.

import path from "path";
import fs from "fs";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { ensureVideoFile, uploadPathToUrl } from "./youtube";
import { ensureVideoFileAnyUrl, isYouTubeUrl } from "./anywhere";
import { downloadEditPlanAssets } from "./higgsfieldAssets";
import type { EditPlan } from "./types";

/** Rendering writes hundreds of MB (source mp4 + output mp4). Serverless
 *  hosts like Vercel have a read-only app directory — fail up front with a
 *  human message instead of ENOENT/EROFS mid-render. */
export function assertWritableDisk() {
  const probeDir = path.join(process.cwd(), "public", "renders");
  try {
    fs.mkdirSync(probeDir, { recursive: true });
    const probe = path.join(probeDir, `.write-probe-${Date.now()}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch {
    throw new Error(
      "Rendering needs a writable disk for the source + output mp4 files, " +
        "which this host does not provide (Vercel's serverless filesystem is " +
        "read-only). Run this step on your PC or on Railway instead — both work."
    );
  }
}

/**
 * Renders ONE clip of an edit plan to public/renders/<clipId>.mp4.
 * Analyze is metadata-only, so the actual video FILE is fetched here lazily
 * (cached in public/uploads — each video downloads at most once). Also
 * downloads any Higgsfield generated assets, then records provenance in the
 * renders manifest so the UI can match clips to their source video.
 *
 * Returns the public-facing clip URL + clipId.
 */
export async function renderClipToDisk(
  editPlan: EditPlan,
  clipIndex: number,
  sourceUrl?: string
): Promise<{ url: string; clipId: string }> {
  if (!editPlan?.clips?.[clipIndex]) {
    throw new Error("Invalid editPlan or clipIndex");
  }
  assertWritableDisk();

  const plan: EditPlan = { ...editPlan };
  if (!plan.sourceVideoPath) {
    if (!sourceUrl) {
      throw new Error(
        "No video file for this plan yet and no source URL was provided — " +
          "analyze the video again first."
      );
    }
    plan.sourceVideoPath = isYouTubeUrl(sourceUrl)
      ? // ensureVideoFile returns an absolute on-disk path; Remotion fetches
        // it over http, so convert it to the served localhost URL.
        uploadPathToUrl(await ensureVideoFile(sourceUrl))
      : (await ensureVideoFileAnyUrl(sourceUrl)).fileUrl;
  }

  // Download Higgsfield-generated assets (B-roll, images, effects) so Remotion
  // can composite them. Cached in public/uploads — each asset is downloaded
  // exactly once.
  if (plan.generatedAssets?.length) {
    try {
      const downloaded = await downloadEditPlanAssets(plan);
      plan.generatedAssets = downloaded.generatedAssets;
    } catch (err) {
      console.error("[Render] Higgsfield asset download failed:", err);
      // Continue without assets — render still works with source video
    }
  }

  const bundled = await bundle({
    entryPoint: path.join(process.cwd(), "remotion", "index.ts"),
  });
  const inputProps = { editPlan: plan, clipIndex };

  const composition = await selectComposition({
    serveUrl: bundled,
    id: "ShortClip",
    inputProps,
  });

  const outDir = path.join(process.cwd(), "public", "renders");
  fs.mkdirSync(outDir, { recursive: true });
  const clipId = plan.clips[clipIndex].clipId || `clip-${clipIndex}`;
  const outputLocation = path.join(outDir, `${clipId}.mp4`);

  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: "h264",
    outputLocation,
    inputProps,
  });

  // Record provenance so the UI's "already rendered" gallery + hydration can
  // prove WHICH video a file came from (prevents posting a stale clip from a
  // different source video).
  const manifestPath = path.join(outDir, "manifest.json");
  let manifest: { renders: any[] } = { renders: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (Array.isArray(parsed.renders)) manifest = parsed;
  } catch {
    /* first render */
  }
  const fileName = `${clipId}.mp4`;
  // Which source video this clip came from, as the uploads-file basename
  // (e.g. "up-1a2b3c.mp4" for an upload, or "yQY2n4nea2A.mp4" / an
  // "any-…" slug for a URL download). Uploaded videos have no sourceUrl, so
  // this is the only identity that lets the UI re-match a render to the
  // currently-loaded video after a page refresh.
  const sourceFile = (plan.sourceVideoPath || "").split("/").pop() || "";
  const renders = manifest.renders.filter((r) => r.file !== fileName);
  renders.push({
    file: fileName,
    sourceUrl: sourceUrl ?? "",
    sourceFile,
    sourceStartSec: plan.clips[clipIndex].sourceStartSec,
    sourceEndSec: plan.clips[clipIndex].sourceEndSec,
    hookTitle: plan.clips[clipIndex].hookTitle ?? "",
    renderedAt: new Date().toISOString(),
  });
  fs.writeFileSync(manifestPath, JSON.stringify({ renders }, null, 2));

  return { url: `/renders/${clipId}.mp4`, clipId };
}