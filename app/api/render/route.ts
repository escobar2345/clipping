import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { withAuth } from "../../../lib/withAuth";
import { rendersDir, rendersUrlPath } from "../../../lib/userPaths";
import { resolveRenderSourceVideo } from "../../../lib/renderSource";
import type { EditPlan } from "../../../lib/types";
import { sanitizeClipId } from "../../../lib/planNormalize";
import { refineClipCaptions, deepgramMode } from "../../../lib/deepgram";
import { videoUrlToLocalPath } from "../../../lib/visualScan";
import { computeCrop, reframeEnabled } from "../../../lib/reframe";

// Rendering is CPU/IO heavy — run this on the Node runtime, not the edge.
export const runtime = "nodejs";
export const maxDuration = 300;

/** Rendering writes hundreds of MB (source mp4 + output mp4). Serverless
 *  hosts like Vercel have a read-only app directory — fail up front with a
 *  human message instead of ENOENT/EROFS mid-render. */
function assertWritableDisk() {
  const probeDir = rendersDir();
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

export const POST = withAuth(
  async (req: Request) => {
  try {
    const { editPlan, clipIndex, sourceUrl } = (await req.json()) as {
      editPlan: EditPlan;
      clipIndex: number;
      sourceUrl?: string;
    };

    if (!editPlan?.clips?.[clipIndex]) {
      return NextResponse.json({ error: "Invalid editPlan or clipIndex" }, { status: 400 });
    }

    assertWritableDisk();

    // Resolve a local upload to the streaming endpoint. If a deploy/restart
    // removed a cached URL video, re-fetch it before handing it to Remotion.
    const plan: EditPlan = { ...editPlan };
    plan.sourceVideoPath = await resolveRenderSourceVideo(
      plan.sourceVideoPath,
      sourceUrl ?? plan.sourceUrl
    );

    // Deepgram pass (DEEPGRAM_API_KEY): word-accurate captions for this clip.
    // Skipped when the whole plan was already built from a Deepgram transcript
    // (same words, nothing to gain, would just spend credit twice). Any
    // failure — no key, exhausted credit, network — keeps the plan's captions.
    if (deepgramMode() !== "off" && plan.transcriptSource !== "deepgram") {
      const local = videoUrlToLocalPath(plan.sourceVideoPath);
      if (local) {
        const refined = await refineClipCaptions(plan.clips[clipIndex], local);
        if (refined) plan.clips = plan.clips.map((c, i) => (i === clipIndex ? refined : c));
      }
    }

    // Smart reframing: find the speaker's face and slide the 9:16 window to
    // follow it, instead of always keeping the middle of a wide video. Falls
    // back to the centred crop whenever no face is reliably found (or on any
    // error), so it can only help. SMART_REFRAME=0 disables it.
    if (reframeEnabled()) {
      const localForCrop = videoUrlToLocalPath(plan.sourceVideoPath);
      if (localForCrop) {
        const crop = await computeCrop(localForCrop, plan.clips[clipIndex]);
        if (crop) plan.clips = plan.clips.map((c, i) => (i === clipIndex ? { ...c, crop } : c));
      }
    }

    const clip = plan.clips[clipIndex];

    const bundled = await bundle({
      entryPoint: path.join(process.cwd(), "remotion", "index.ts"),
    });

    const inputProps = { editPlan: plan, clipIndex };

    const composition = await selectComposition({
      serveUrl: bundled,
      id: "ShortClip",
      inputProps,
    });

    const outDir = rendersDir();
    fs.mkdirSync(outDir, { recursive: true });
    // clipId arrives in client JSON and becomes a file name — strip path chars
    const clipId = sanitizeClipId(editPlan.clips[clipIndex].clipId, `clip-${clipIndex}`);
    const outputLocation = path.join(outDir, `${clipId}.mp4`);

    console.info(`[render] starting Remotion render clip=${clipId} index=${clipIndex}`);
    let lastLoggedPercent = -10;
    await renderMedia({
      composition,
      serveUrl: bundled,
      codec: "h264",
      outputLocation,
      inputProps,
      onStart: ({ frameCount, resolvedConcurrency }) => {
        console.info(
          `[render] Remotion started clip=${clipId} frames=${frameCount} concurrency=${resolvedConcurrency}`
        );
      },
      onProgress: ({ progress, renderedFrames }) => {
        const percent = Math.floor(progress * 100);
        if (percent === 100 || percent >= lastLoggedPercent + 10) {
          lastLoggedPercent = percent;
          console.info(`[render] progress clip=${clipId} percent=${percent} frames=${renderedFrames}`);
        }
      },
    });

    // Record provenance so the UI's "already rendered" gallery + hydration can
    // prove WHICH video a file came from (prevents posting a stale clip from
    // a different source video).
    const manifestPath = path.join(outDir, "manifest.json");
    let manifest: { renders: any[] } = { renders: [] };
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (Array.isArray(parsed.renders)) manifest = parsed;
    } catch {
      /* first render */
    }
    const fileName = `${clipId}.mp4`;
    const renders = manifest.renders.filter((r) => r.file !== fileName);
    renders.push({
      file: fileName,
      sourceUrl: sourceUrl ?? "",
      sourceStartSec: clip.sourceStartSec,
      sourceEndSec: clip.sourceEndSec,
      hookTitle: clip.hookTitle ?? "",
      renderedAt: new Date().toISOString(),
    });
    fs.writeFileSync(manifestPath, JSON.stringify({ renders }, null, 2));

    return NextResponse.json({ url: rendersUrlPath(`${clipId}.mp4`) });
  } catch (err: any) {
    console.error("[render] request failed:", err?.stack ?? err);
    return NextResponse.json({ error: err.message ?? "Render failed" }, { status: 500 });
  }
  }
  // NOT metered: the video was already counted when it was analyzed/uploaded.
  // Metering here would burn one quota unit per rendered clip.
);
