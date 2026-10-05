import { NextResponse } from "next/server";
import { withAuth } from "../../../lib/withAuth";
import { recordAnalyzeEvent } from "../../../lib/billing";
import { fetchVideoIntel } from "../../../lib/apify";

/**
 * Analyze a pasted video URL (Step 01).
 *
 * Body: { youtubeUrl } or { url } — the UI sends both.
 * Response: { intel, videoFilePending, transcriptSource, warnings }
 *
 * Metadata-only by design: Apify supplies title/duration/transcript, but the
 * video FILE is not downloaded here — `intel.videoFilePath` stays empty and
 * /api/render pulls the pixels lazily through yt-dlp. That's what
 * `videoFilePending` tells the UI, so the extra wait at render time is expected
 * rather than a surprise.
 *
 * Every failure path returns JSON with a human-readable `error` — the client
 * must never have to parse an HTML page from this route.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

export const POST = withAuth(
  async (req: Request) => {
  try {
    let body: { youtubeUrl?: string; url?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const url = (body.youtubeUrl ?? body.url ?? "").trim();
    if (!url) {
      return NextResponse.json(
        { error: "Paste a video link first (YouTube, TikTok, Instagram, Vimeo, a direct mp4…)." },
        { status: 400 }
      );
    }

    const { intel, transcriptSource, warnings } = await fetchVideoIntel(url);

    // Count it against this month's quota. Never throws — usage tracking must
    // not be able to fail a user's actual work.
    await recordAnalyzeEvent();

    return NextResponse.json({
      intel,
      // No local file yet — /api/render downloads it on first render.
      videoFilePending: !intel.videoFilePath,
      transcriptSource,
      warnings,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Could not analyze that video." },
      { status: 500 }
    );
  }
  },
  // Counts against the monthly video allowance; 402 when it's used up.
  { metered: "analyze" }
);