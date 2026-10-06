// Viral-pack engine: per-platform caption + hashtags + title + sound
// action + best-time + checklist, grounded in the deep playbooks in
// lib/platforms.ts plus live trend research.
import type { PlatformSpec } from "./platforms";
import type { ResearchSource } from "./apify";
import type { TrendingSound } from "./trends";

export interface ViralCaption {
  platform: string;
  caption: string;
  hashtags: string[];
  title?: string;
  pinnedComment?: string;
  soundAction?: string;
  bestTime?: string;
  checklist?: string[];
}

export interface ViralPackResult {
  captions: ViralCaption[];
  tips: string[];
  researchNote: string;
}

export async function buildViralPack(input: {
  topic: string;
  draftCaption?: string;
  hookTitle?: string;
  platforms: PlatformSpec[];
  research: ResearchSource[];
  sounds: TrendingSound[];
}): Promise<ViralPackResult> {
  const openaiModule = await import("openai");
  const glm = new openaiModule.default({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
  });
  const sys = `You are a short-form growth strategist. For EACH platform spec given, write a ready-to-post pack: caption (respect maxCaptionChars + hashtagStrategy), hashtags (respect hashtagCount), title (YouTube <=60 chars keyword-first), pinnedComment (question CTA), soundAction (exact attach-in-app step using trending sounds when provided), bestTime (from postingWindows), checklist (pick 4 most critical). Then 3-6 non-generic tips grounded in research/sounds. ONLY valid JSON, no prose:\ntype Out={captions:{platform:string;caption:string;hashtags:string[];title?:string;pinnedComment?:string;soundAction?:string;bestTime?:string;checklist?:string[]}[];tips:string[]};`;
  const user = {
    topic: input.topic, draftCaption: input.draftCaption ?? null,
    hookTitle: input.hookTitle ?? null,
    platforms: input.platforms.map((p) => ({
      id: p.id, label: p.label, maxCaptionChars: p.maxCaptionChars,
      hashtagStrategy: p.hashtagStrategy, hashtagCount: p.hashtagCount,
      cta: p.cta, rankingSignals: p.rankingSignals,
      viralLevers: p.viralLevers, soundGuidance: p.soundGuidance,
      postingWindows: p.postingWindows,
    })),
    webResearch: input.research.slice(0, 12).map((r) => ({ title: r.title, snippet: r.description })),
    trendingSounds: input.sounds.slice(0, 8),
  };
  const completion = await glm.chat.completions.create({
    model: process.env.NVIDIA_GLM_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b",
    temperature: 0.7,
    messages: [{ role: "system", content: sys }, { role: "user", content: JSON.stringify(user) }],
  });
  const raw = completion.choices[0]?.message?.content ?? "{}";
  let parsed: { captions?: ViralCaption[]; tips?: string[] };
  try { parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()); }
  catch (e) { throw new Error(`GLM viral pack not JSON: ${String(e)}`); }
  return {
    captions: parsed.captions ?? [], tips: parsed.tips ?? [],
    researchNote: input.research.length
      ? `Grounded in ${input.research.length} web results + ${input.sounds.length} trending sounds for "${input.topic}".`
      : "No live research â€” model knowledge only.",
  };
}
