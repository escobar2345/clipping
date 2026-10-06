// Trending-sound + hashtag research for viral distribution.
// Order: Apify TikTok scrapers (live sound/hashtag velocity) first,
// then Google SERP fallback (what the web says is trending for a niche).

import { ApifyClient } from "apify-client";
import { withRetry } from "./retry";

export interface TrendingSound {
  title: string;
  author?: string;
  uses?: number | string;
  url?: string;
  trending?: boolean;
}

export interface TrendPack {
  topic: string;
  sounds: TrendingSound[];
  hashtags: string[];
  sources: string[];
  note: string;
}

const TIKTOK_TREND_ACTORS = [
  "clockworks~tiktok-scraper",
  "apify~tiktok-scraper",
];

export async function fetchTrendingSounds(topic: string): Promise<TrendPack> {
  const token = process.env.APIFY_TOKEN;
  const sounds: TrendingSound[] = [];
  const hashtags: string[] = [];
  const sources: string[] = [];
  if (!token) {
    return { topic, sounds, hashtags, sources, note: "APIFY_TOKEN not set — connect Apify to unlock live trending sounds." };
  }
  const client = new ApifyClient({ token });
  // Try each known TikTok actor with a trending/discover input; actors change
  // schemas often so every attempt is best-effort and failures fall through.
  const queries = [`${topic} trending sound tiktok`, `trending tiktok sounds ${topic}`];
  for (const actor of TIKTOK_TREND_ACTORS) {
    try {
      const run = await withRetry(() => client.actor(actor).call({
        searchQueries: queries, resultsPerPage: 10, shouldDownloadVideos: false,
      } as any), 1);
      const { items } = await withRetry(() => client.dataset(run.defaultDatasetId).listItems(), 1);
      for (const it of (items as any[]).slice(0, 20)) {
        const snd = it.music || it.sound || it.audio || {};
        const name = snd.title || snd.name || it.soundName || "";
        if (name) sounds.push({
          title: String(name),
          author: snd.author ? String(snd.author) : undefined,
          uses: snd.uses ?? it.musicUses ?? undefined,
          url: snd.url || it.soundUrl || undefined,
          trending: true,
        });
        const tags: string[] = it.hashtags || it.challenges || [];
        for (const t of tags) {
          const h = String(typeof t === "string" ? t : (t as any).name || "").replace(/^#/, "");
          if (h && !hashtags.includes(h)) hashtags.push(h);
        }
      }
      if (sounds.length || hashtags.length) { sources.push(actor); break; }
    } catch { /* try next actor */ }
  }
  const note = sounds.length
    ? `Live TikTok signals via ${sources.join(", ")}: attach the top sound natively in the TikTok app after Buffer publishes (Buffer URL posts cannot set sounds).`
    : "No live sound feed returned — actors may need input-shape updates; use TikTok Creative Center trending + the niche hashtags below.";
  return { topic, sounds: sounds.slice(0, 10), hashtags: hashtags.slice(0, 15), sources, note };
}
