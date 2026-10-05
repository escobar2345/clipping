import type { ResearchSource } from "./apify";

// Re-exported so client components can import all coach types from here.
export type { ResearchSource };

// Caption coaching: turns live web research (Apify, see lib/apify.ts) plus
// optional recent performance context (Buffer analytics) into platform-
// specific captions, hashtags, and posting advice via GLM on NVIDIA.

export interface PlatformCaption {
  platform: string;
  caption: string;
  hashtags: string[];
}

export interface CaptionCoachResult {
  research: ResearchSource[];
  captions: PlatformCaption[];
  tips: string[];
  researchNote: string;
}

/**
 * Combines live web research + the account's own performance context with GLM
 * to produce platform-specific captions, hashtags, and actionable posting
 * advice aimed at maximizing reach.
 */
export async function coachCaptions(input: {
  topic: string;
  draftCaption?: string;
  platforms: string[];
  research: ResearchSource[];
  performanceContext?: string;
}): Promise<CaptionCoachResult> {
  const openaiModule = await import("openai");
  const glm = new openaiModule.default({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  });

  const systemPrompt = `You are a social media growth strategist for short-form video.
You are given: (1) live web-research snippets about what is currently ranking
around the creator's topic, (2) optionally the creator's draft caption and/or
recent performance stats from their Buffer analytics, and (3) target platforms.

Produce, for EACH platform: a rewritten caption optimized for that platform's
culture/length limits/reach mechanics (hook first line, line breaks, CTA),
plus 5-10 high-intent hashtags informed by the research. Then give 3-6 short,
specific, non-generic posting tips (timing, format, engagement tactics)
grounded in the research or stats when they are available.

Respond with ONLY valid JSON matching this TypeScript type, no prose, no
markdown fences:

type CoachResult = {
  captions: { platform: string; caption: string; hashtags: string[] }[];
  tips: string[];
};`;

  const userPayload = {
    topic: input.topic,
    platforms: input.platforms,
    draftCaption: input.draftCaption ?? null,
    recentPerformance: input.performanceContext ?? null,
    webResearch: input.research.map((r) => ({ title: r.title, snippet: r.description })),
  };

  const completion = await glm.chat.completions.create({
    model: process.env.NVIDIA_GLM_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b",
    temperature: 0.7,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
  });

  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: { captions?: PlatformCaption[]; tips?: string[] };
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (err) {
    throw new Error(`GLM did not return valid JSON coaching output: ${String(err)}`);
  }

  return {
    research: input.research,
    captions: parsed.captions ?? [],
    tips: parsed.tips ?? [],
    researchNote:
      input.research.length > 0
        ? `Grounded in ${input.research.length} live web results about "${input.topic}".`
        : "No live research was retrieved â€” advice is model knowledge only.",
  };
}