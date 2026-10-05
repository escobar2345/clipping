import { NextResponse } from "next/server";
import { researchTopic } from "../../../../lib/apify";
import { withAuth } from "../../../../lib/withAuth";
import { coachCaptions } from "../../../../lib/captionCoach";

export const runtime = "nodejs";

/**
 * POST { topic, draftCaption?, platforms, skipResearch? }
 *
 * 1. Apify SERP actor searches the live internet around the topic
 *    (viral hooks, trending hashtags, growth tips).
 * 2. GLM turns that research (+ your draft caption, if any) into a rewritten,
 *    platform-specific caption with hashtags plus concrete reach tips.
 *
 * A paid feature — the web research costs Apify credits on every call.
 */
export const POST = withAuth(
  async (req: Request) => {
  try {
    const { topic, draftCaption, platforms, skipResearch } = await req.json();

    if (!topic || !Array.isArray(platforms) || platforms.length === 0) {
      return NextResponse.json(
        { error: "topic and a non-empty platforms array are required" },
        { status: 400 }
      );
    }

    // Live web research — skipped only when explicitly requested (e.g. to save
    // Apify credits); coaching still runs without it.
    let research: Awaited<ReturnType<typeof researchTopic>> = [];
    let researchError: string | undefined;
    if (!skipResearch) {
      try {
        research = await researchTopic(topic);
      } catch (err: any) {
        researchError = err.message;
      }
    }

    const result = await coachCaptions({
      topic,
      draftCaption,
      platforms,
      research,
    });

    return NextResponse.json({ ...result, researchError });
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Caption coaching failed" }, { status: 500 });
  }
  },
  { plan: "paid" }
);