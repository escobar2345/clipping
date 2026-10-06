// Deep per-platform viral playbooks for long2short.
// TikTok = trending sound + completion/rewatch + hashtags-as-search,
// Instagram = Reels trial + Stories stickers + save/share,
// YouTube Shorts = title-as-search + first-2s retention,
// X = text-first, Facebook = discussion/shares.

export type PlatformId =
  | "tiktok"
  | "instagram_reels"
  | "instagram_story"
  | "youtube_shorts"
  | "x"
  | "facebook";

export interface PlatformSpec {
  id: PlatformId;
  label: string;
  bufferServices: string[];
  sweetSpotSec: [number, number];
  maxSec: number;
  hashtagStrategy: string;
  hashtagCount: [number, number];
  maxCaptionChars: number;
  cta: string;
  rankingSignals: string[];
  viralLevers: string[];
  soundGuidance: string;
  postingWindows: string[];
  checklist: string[];
}

export function normalizeService(s: string): PlatformId | null {
  const v = (s || "").toLowerCase();
  if (v.includes("tiktok")) return "tiktok";
  if (v.includes("instagram") || v === "ig") return "instagram_reels";
  if (v.includes("youtube") || v.includes("shorts")) return "youtube_shorts";
  if (v === "x" || v.includes("twitter")) return "x";
  if (v.includes("facebook") || v === "fb") return "facebook";
  return null;
}
export const PLATFORMS: Record<string, PlatformSpec> = {
  tiktok: {
    id: "tiktok", label: "TikTok (Feed + Story)", bufferServices: ["tiktok"],
    sweetSpotSec: [21, 34], maxSec: 600,
    hashtagStrategy: "3-5 tags: 1 broad + 2 niche + 1 search-keyword matching spoken words",
    hashtagCount: [3, 5], maxCaptionChars: 2200,
    cta: "Question CTA last line to drive comments",
    rankingSignals: ["Watch time + completion (top)", "Rewatches/loops", "Comments first 60min", "Shares+saves", "Trending-sound velocity"],
    viralLevers: ["Trending sound natively at 5-15pct under voice", "Hook first 1-2s on-screen+spoken", "Open loop ending for loops", "Hashtags as search keywords", "Story teaser same day", "Duet/Stitch ON", "Video-reply to early comments"],
    soundGuidance: "Buffer cannot attach sounds — re-attach natively in TikTok app after Buffer publishes via Use-sound. See /api/trends/sounds.",
    postingWindows: ["Tue/Thu 18-21h local", "Sat 10-13h", "Test 06-08h"],
    checklist: ["Clip 21-34s or Part1/Part2", "Hook burned at 0s+spoken 2s", "Loop point flows", "Hook+question+3-5 tags", "Trending sound picked", "Story teaser same day", "Duet/Stitch ON"],
  },
  instagram_reels: {
    id: "instagram_reels", label: "Instagram Reels", bufferServices: ["instagram"],
    sweetSpotSec: [15, 30], maxSec: 180,
    hashtagStrategy: "3-5 niche tags at end; keyword sentence first (IG search indexes it)",
    hashtagCount: [3, 5], maxCaptionChars: 2200,
    cta: "Save/share CTA ('Save this', 'Send to someone who...')",
    rankingSignals: ["Watch time + saves/shares", "Trial-reel conversion", "Profile visits+follows", "Comment depth"],
    viralLevers: ["Trial Reels to non-followers", "Keyword first sentence", "Cover hook text", "Collab invite 1 partner", "Trending audio re-attached in IG", "Pin winner"],
    soundGuidance: "Re-attach trending audio in IG app: Reels editor -> Audio -> Trending (arrow-up icon).",
    postingWindows: ["Mon-Fri 11-13h", "Mon-Fri 19-21h", "Sun 10-12h"],
    checklist: ["15-30s ideal <=90s", "Searchable first line", "3-5 niche tags", "Cover hook", "Save/share CTA", "Collab partner"],
  },
  instagram_story: {
    id: "instagram_story", label: "Instagram Story (teaser)", bufferServices: ["instagram"],
    sweetSpotSec: [7, 15], maxSec: 60,
    hashtagStrategy: "1 location + 1 niche sticker-tag",
    hashtagCount: [1, 2], maxCaptionChars: 220,
    cta: "Sticker CTA: Poll / Question / Link to Reel",
    rankingSignals: ["Sticker taps", "Forward-taps vs exits", "DM replies", "Link taps"],
    viralLevers: ["15s teaser (payoff withheld)", "Poll+Question+Countdown stickers", "Link sticker to Reel", "Location sticker", "Close Friends seed"],
    soundGuidance: "Stories music sticker — same track as Reel so taps funnel to audio page.",
    postingWindows: ["Daily 08h + 12h + 20h"],
    checklist: ["7-15s teaser cut", "Poll+Link safe zone", "Hook 1s readable", "Location sticker"],
  },
};

export const PLATFORMS_B: Record<string, PlatformSpec> = {
  youtube_shorts: {
    id: "youtube_shorts", label: "YouTube Shorts", bufferServices: ["youtube", "youtube_shorts"],
    sweetSpotSec: [25, 45], maxSec: 180,
    hashtagStrategy: "Title-first SEO: keywords front-loaded <=60 chars, 3 tags in desc + #Shorts",
    hashtagCount: [3, 4], maxCaptionChars: 5000,
    cta: "Pinned comment question + subscribe in first hour",
    rankingSignals: ["AVD first 48h", "Viewed-vs-swiped rate", "Long-form sub conversion"],
    viralLevers: ["Searchable title", "First frame = payoff", "Pinned comment hour 1", "Link long-form", "Verbal subscribe last 2s"],
    soundGuidance: "Retention beats audio trends; keep original audio dominant.",
    postingWindows: ["Tue-Thu 12-15h", "Fri-Sun 09-11h"],
    checklist: ["Title <=60 chars + #Shorts", "Hook 2s", "Pinned comment", "Long-form link"],
  },
  x: {
    id: "x", label: "X / Twitter", bufferServices: ["x", "twitter"],
    sweetSpotSec: [15, 45], maxSec: 140,
    hashtagStrategy: "Max 1-2 tags — bare text outperforms blocks",
    hashtagCount: [0, 2], maxCaptionChars: 280,
    cta: "One idea + quote-tweet CTA",
    rankingSignals: ["Replies+reposts velocity", "Profile clicks", "Muted completion"],
    viralLevers: ["Native upload", "Standalone first line", "Self-reply thread"],
    soundGuidance: "Muted by default — burned-in captions ARE the sound plan.",
    postingWindows: ["Mon-Fri 08-10h", "Mon-Fri 18-21h"],
    checklist: ["<=280 chars 1 idea", "Captions burned", "1-2 tags max"],
  },
  facebook: {
    id: "facebook", label: "Facebook Reels", bufferServices: ["facebook"],
    sweetSpotSec: [15, 45], maxSec: 180,
    hashtagStrategy: "1-2 tags max — conversational 2-4 sentences + group-share prompt",
    hashtagCount: [1, 2], maxCaptionChars: 2000,
    cta: "Discussion CTA + share-to-group",
    rankingSignals: ["Shares to groups/chats", "Thread depth", "Follows from Reels"],
    viralLevers: ["Share to 1-2 Groups", "Discussion caption", "IG cross-post toggle"],
    soundGuidance: "Mirror IG track for cross-post consistency.",
    postingWindows: ["Mon-Fri 09-13h", "Thu-Sun 19-21h"],
    checklist: ["Conversation caption", "Group list ready"],
  },
};

export function specsForServices(services: string[]): PlatformSpec[] {
  const all: Record<string, PlatformSpec> = { ...(PLATFORMS as any), ...PLATFORMS_B };
  const seen = new Set<string>();
  const out: PlatformSpec[] = [];
  for (const s of services) {
    const p = normalizeService(s);
    if (p && p !== "instagram_story" && !seen.has(p) && (all as any)[p]) {
      seen.add(p); out.push((all as any)[p]);
    }
  }
  if (!out.length) return [all.tiktok, all.instagram_reels, all.youtube_shorts];
  return out;
}

export function allSpecs(): PlatformSpec[] {
  const all: Record<string, PlatformSpec> = { ...(PLATFORMS as any), ...PLATFORMS_B };
  return [all.tiktok, all.instagram_reels, all.instagram_story, all.youtube_shorts, all.x, all.facebook];
}
