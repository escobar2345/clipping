import fs from "fs";
import type { VideoIntel } from "./types";
import { ensureVideoFile } from "./youtube";
import { ensureVideoFileAnyUrl, isYouTubeUrl } from "./anywhere";
import { videoUrlToLocalPath } from "./visualScan";
import { deepgramMode, transcribeFullVideo } from "./deepgram";

export type TranscriptSource = "captions" | "deepgram" | "none";

/**
 * Makes sure `intel.transcript` has the spoken words the AI needs to pick
 * clips. Free platform captions are used when they exist (no download needed);
 * when there are none — uploads, local files, sites without subtitles — Deepgram
 * transcribes the video. Mutates `intel` (transcript + videoFilePath).
 *
 * Never throws: on any problem (no key, out of credit, download failure) it
 * returns "none" and the caller falls back to the visual-only plan as before.
 */
export async function ensureTranscript(intel: VideoIntel): Promise<TranscriptSource> {
  if (intel.transcript?.length) return "captions";
  if (deepgramMode() === "off") return "none";

  try {
    let local = videoUrlToLocalPath(intel.videoFilePath);
    if (!local || !fs.existsSync(local)) {
      if (!intel.sourceUrl) return "none";
      // Same download /api/render would do anyway; the file is cached, so
      // fetching it now costs nothing extra overall.
      intel.videoFilePath = isYouTubeUrl(intel.sourceUrl)
        ? await ensureVideoFile(intel.sourceUrl)
        : (await ensureVideoFileAnyUrl(intel.sourceUrl)).fileUrl;
      local = videoUrlToLocalPath(intel.videoFilePath);
    }
    if (!local) return "none";

    const words = await transcribeFullVideo(local);
    if (words?.length) {
      intel.transcript = words;
      return "deepgram";
    }
  } catch (err) {
    console.warn("[transcript] could not get a Deepgram transcript:", String(err));
  }
  return "none";
}
