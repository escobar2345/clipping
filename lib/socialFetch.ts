import { execFile } from "child_process";
import { promisify } from "util";
import { ApifyClient } from "apify-client";
import { withRetry } from "./retry";

const execFileAsync = promisify(execFile);

// Fetches the TEXT of an existing social post from its URL, so the chat
// assistant can repurpose it for other platforms. Order: local yt-dlp
// (--dump-single-json — free, covers TikTok/YouTube/Dailymotion/most sites),
// then a platform-specific Apify scraper for the walls yt-dlp can't pass
// (X/Twitter, Instagram, Facebook). Input shapes taken from each actor's
// store README (checked 2026-09); if an actor changes its schema the error
// surfaces with the run id instead of being swallowed.

export type Platform =
  | "tiktok"
  | "twitter"
  | "instagram"
  | "youtube"
  | "facebook"
  | "dailymotion"
  | "other";

export interface FetchedPost {
  platform: Platform;
  url: string;
  text: string;
  title?: string;
  author?: string;
  via: "yt-dlp" | "apify";
}

export function detectPlatform(url: string): Platform {
  const u = url.toLowerCase();
  if (u.includes("tiktok.com")) return "tiktok";
  if (u.includes("twitter.com") || u.includes("x.com/")) return "twitter";
  if (u.includes("instagram.com")) return "instagram";
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("facebook.com") || u.includes("fb.watch")) return "facebook";
  if (u.includes("dailymotion.com") || u.includes("dai.ly")) return "dailymotion";
  return "other";
}

async function viaYtDlp(url: string): Promise<FetchedPost | null> {
  try {
    const { stdout } = await execFileAsync(
      "yt-dlp",
      ["--no-playlist", "--dump-single-json", "--no-warnings", url],
      { timeout: 90_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
    );
    const j = JSON.parse(stdout);
    const text = [j.description, j.title].filter(Boolean).join("\n").trim();
    if (!text) return null;
    return {
      platform: detectPlatform(url),
      url,
      text,
      title: j.title,
      author: j.uploader ?? j.channel,
      via: "yt-dlp",
    };
  } catch {
    return null;
  }
}

const APIFY_FALLBACKS: Record<
  string,
  { actor: string; input: (url: string) => any; pick: (item: any) => string }
> = {
  twitter: {
    actor: "apidojo~tweet-scraper",
    input: (u) => ({ tweetUrls: [u] }),
    pick: (i) => i.text ?? "",
  },
  instagram: {
    actor: "apify~instagram-scraper",
    input: (u) => ({ directUrls: [u], resultsType: "posts" }),
    pick: (i) => i.caption ?? "",
  },
  tiktok: {
    actor: "clockworks~tiktok-scraper",
    input: (u) => ({ urls: [u], shouldDownloadVideos: false }),
    pick: (i) => i.text ?? "",
  },
  facebook: {
    actor: "apify~facebook-posts-scraper",
    input: (u) => ({ startUrls: [u] }),
    pick: (i) => i.text ?? "",
  },
};

export async function fetchPostContent(url: string): Promise<FetchedPost> {
  if (!/^https?:\/\//i.test(url ?? "")) {
    throw new Error("That doesn't look like a URL.");
  }
  const platform = detectPlatform(url);

  const local = await viaYtDlp(url);
  if (local) return local;

  const fb = APIFY_FALLBACKS[platform];
  if (!fb) {
    throw new Error(
      `Couldn't fetch that post locally and there is no Apify fallback wired for ${platform}.`
    );
  }
  if (!process.env.APIFY_TOKEN) {
    throw new Error(
      "yt-dlp couldn't fetch this post and APIFY_TOKEN is not set for the scraper fallback."
    );
  }
  const client = new ApifyClient({ token: process.env.APIFY_TOKEN });
  const run = await withRetry(() => client.actor(fb.actor).call(fb.input(url)), 2);
  const { items } = await withRetry(
    () => client.dataset(run.defaultDatasetId).listItems(),
    2
  );
  const first = items[0] as Record<string, any> | undefined;
  const text = items.map((i: any) => fb.pick(i)).filter(Boolean)[0] ?? "";
  if (!text) {
    throw new Error(`The ${fb.actor} actor returned no text for this post.`);
  }
  return {
    platform,
    url,
    text,
    author:
      first?.author?.uniqueId ?? first?.username ?? first?.ownerUsername ?? undefined,
    via: "apify",
  };
}