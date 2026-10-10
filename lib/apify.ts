import fs from "fs";
import path from "path";
import { withRetry } from "./retry";
import { extractTranscript } from "./subtitles";
import { extractVideoId } from "./youtube";
import { probeMetadata } from "./ytdlp";
import type { TranscriptWord, VideoIntel } from "./types";

/**
 * Apify — fetches the metadata and transcript for a source video.
 *
 * Runs a configurable YouTube actor (APIFY_YOUTUBE_ACTOR_ID) and maps whatever
 * it returns into the app's `VideoIntel` shape. Different actors name fields
 * differently, so `mapItem()` coerces the common variants instead of assuming
 * one schema — see README ("lib/apify.ts has placeholder field names").
 *
 * When the actor returns NO transcript, Analyze returns without trying a slow
 * yt-dlp caption scrape. Deepgram can transcribe at edit-plan time; without it,
 * the planner uses visual-only analysis.
 *
 *   APIFY_TOKEN              required, from apify.com → Settings → Integrations
 *   APIFY_YOUTUBE_ACTOR_ID   required, e.g. "streamers~youtube-scraper"
 *   APIFY_API_BASE           optional, defaults to https://api.apify.com/v2
 *   APIFY_RUN_TIMEOUT_SEC    optional, defaults to 240
 *
 * This step is METADATA-ONLY by design: `videoFilePath` is left empty and the
 * pixels are pulled lazily at render time (see lib/youtube.ts), so pasting a
 * link stays fast.
 */

const APIFY_BASE = (process.env.APIFY_API_BASE ?? "https://api.apify.com/v2").replace(/\/+$/, "");
const RUN_TIMEOUT_SEC = Number(process.env.APIFY_RUN_TIMEOUT_SEC ?? 240) || 240;

/** Reads a required env var or throws a message naming the exact fix. */
function requireEnv(key: string, hint: string): string {
  const value = (process.env[key] ?? "").trim();
  if (!value || value.startsWith("your_")) {
    throw new Error(
      `${key} is not set in .env.local. ${hint} ` +
        "(copy .env.local.example to .env.local, fill it in, then restart the dev server)."
    );
  }
  return value;
}

function apifyConfig(): { token: string; actorId: string } {
  return {
    token: requireEnv(
      "APIFY_TOKEN",
      "Create one at apify.com → Settings → Integrations → API tokens."
    ),
    actorId: requireEnv(
      "APIFY_YOUTUBE_ACTOR_ID",
      "Pick a YouTube scraper/transcript actor in the Apify Store and paste its id (e.g. streamers~youtube-scraper)."
    ),
  };
}

/** Starts an actor run without waiting, and returns its run id. */
async function startRun(input: Record<string, any>, actorIdOverride?: string): Promise<string> {
  const { token } = apifyConfig();
  const actorId = actorIdOverride ?? apifyConfig().actorId;
  const url =
    `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/runs` +
    `?token=${encodeURIComponent(token)}&waitForFinish=0`;
  const res = await withRetry(
    () =>
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(60_000),
      }),
    2
  );
  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `Apify rejected the run (HTTP ${res.status}): ${body?.error?.message ?? "unknown error"}`
    );
  }
  const runId = body?.data?.id;
  if (!runId) throw new Error("Apify did not return a run id.");
  return String(runId);
}

/** Polls a run until it finishes, then returns its default dataset id. */
async function waitForRun(runId: string): Promise<string> {
  const { token } = apifyConfig();
  const deadline = Date.now() + (RUN_TIMEOUT_SEC + 120) * 1000;
  while (Date.now() < deadline) {
    const res = await withRetry(
      () =>
        fetch(
          `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}?token=${encodeURIComponent(token)}`,
          { cache: "no-store", signal: AbortSignal.timeout(60_000) }
        ),
      2
    );
    const body: any = await res.json().catch(() => null);
    const status = body?.data?.status;
    if (status === "SUCCEEDED") {
      const datasetId = body?.data?.defaultDatasetId;
      if (datasetId) return String(datasetId);
      throw new Error("The Apify run succeeded but returned no dataset.");
    }
    if (status === "FAILED" || status === "ABORTED") {
      throw new Error(
        `The Apify actor ${status.toLowerCase()}: ${body?.data?.error?.message ?? "no reason given"}. ` +
          `See the run at apify.com/actors/runs/${encodeURIComponent(runId)}`
      );
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(
    `The Apify actor still hadn't finished after ${Math.round((RUN_TIMEOUT_SEC + 120) / 60)} minutes.`
  );
}
async function fetchDatasetItems(datasetId: string): Promise<Record<string, any>[]> {
  const { token } = apifyConfig();
  const res = await withRetry(
    () =>
      fetch(
        `${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items` +
          `?token=${encodeURIComponent(token)}&clean=true&format=json`,
        { cache: "no-store", signal: AbortSignal.timeout(120_000) }
      ),
    2
  );
  if (!res.ok) throw new Error(`Could not read the Apify dataset (HTTP ${res.status}).`);
  const items: any = await res.json().catch(() => null);
  return Array.isArray(items) ? items : [];
}

/**
 * Runs the actor and returns its dataset items.
 *
 * Tries the synchronous endpoint first (one round-trip). If the actor outlives
 * the API's limit it falls back to an async run that we poll, so a slow actor
 * still succeeds instead of dying at the timeout.
 */
async function runActor(
  input: Record<string, any>,
  actorIdOverride?: string
): Promise<Record<string, any>[]> {
  const { token } = apifyConfig();
  const actorId = actorIdOverride ?? apifyConfig().actorId;
  const syncUrl =
    `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(token)}&timeout=${RUN_TIMEOUT_SEC}&memory=2048&format=json&retries=2`;

  try {
    const res = await fetch(syncUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout((RUN_TIMEOUT_SEC + 60) * 1000),
    });
    const body: any = await res.json().catch(() => null);

    if (res.ok && Array.isArray(body)) return body;

    // A run id in the payload means it timed out mid-run — finish it off
    // instead of throwing, so the work already done isn't wasted.
    const runId = body?.data?.id ?? body?.runId;
    if (runId) {
      return fetchDatasetItems(await waitForRun(String(runId)));
    }

    // A hard rejection (bad token, actor not found) must not be retried.
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
      throw new Error(
        `Apify returned HTTP ${res.status}: ${body?.error?.message ?? JSON.stringify(body).slice(0, 200)}`
      );
    }
    throw new Error(`Apify returned HTTP ${res.status}.`);
  } catch (err) {
    // Explicit rejections bubble straight up; network blips get one retry via
    // the async path (which is a fresh run, not a repeat of a failed one).
    if (err instanceof Error && /^Apify returned HTTP 4/.test(err.message)) throw err;
    const runId = await startRun(input, actorIdOverride);
    return fetchDatasetItems(await waitForRun(runId));
  }
}
/** First non-empty string among the candidates. */
function firstString(...vals: unknown[]): string {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** First positive finite number among the candidates. */
function firstNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/**
 * Coerces one actor dataset item into the fields we need. Actors disagree on
 * names, so every common variant is tried.
 */
function mapItem(item: Record<string, any>) {
  const info = item?.info ?? {};
  const details = item?.videoDetails ?? {};

  const title =
    firstString(item?.title, item?.name, details?.title, info?.title) || "Untitled video";

  const durationSec = firstNumber(
    item?.duration,
    item?.durationSec,
    item?.durationSeconds,
    item?.lengthSeconds,
    item?.length,
    details?.lengthSeconds,
    info?.durationSec
  );

  // Optional: some actors return cuts as numbers, others as objects.
  const rawCuts = item?.sceneCuts ?? item?.scenes ?? item?.cuts ?? item?.sceneChanges;
  const sceneCuts = Array.isArray(rawCuts)
    ? rawCuts
        .map((c: any) => firstNumber(c, c?.time, c?.timestamp, c?.start, c?.atSec))
        .filter((n): n is number => typeof n === "number")
        .sort((a, b) => a - b)
    : undefined;

  return { title, durationSec, sceneCuts };
}

/** One web search hit used to ground the caption coach's advice. */
export interface ResearchSource {
  title: string;
  description: string;
  url: string;
}

/** Default SERP actor; override with APIFY_SEARCH_ACTOR_ID in .env.local. */
const DEFAULT_SEARCH_ACTOR = "apify/google-search-scraper";

function searchActorId(): string {
  return (process.env.APIFY_SEARCH_ACTOR_ID ?? "").trim() || DEFAULT_SEARCH_ACTOR;
}

function buildQueries(topic: string): string[] {
  const t = topic.trim();
  return [
    `${t} viral short form video hooks examples`,
    `${t} trending hashtags tiktok instagram reels`,
    `${t} content ideas audience growth tips`,
  ];
}

/** Converts "HH:MM:SS" / "MM:SS" (optionally with .ms) into seconds. */
export function parseDurationToSec(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw !== "string") return 0;
  const parts = raw.trim().split(":").map((p) => parseFloat(p));
  if (parts.some((p) => !Number.isFinite(p))) return 0;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + p;
  return Number.isFinite(sec) ? sec : 0;
}

/**
 * Searches the live internet through an Apify SERP actor to see what is
 * actually ranking around the user's topic right now (feeds lib/captionCoach.ts).
 *
 * Uses the official apify/google-search-scraper shape: input { queries, … } →
 * dataset items { organicResults: [{ title, link, description }] }.
 *
 * Throws with an actionable message rather than silently returning nothing, so
 * the Caption Coach panel can tell the user their research key is wrong.
 */
export async function researchTopic(
  topic: string,
  maxResultsPerQuery = 5
): Promise<ResearchSource[]> {
  const queries = buildQueries(topic);

  let items: Record<string, any>[] = [];
  try {
    items = await runActor(
      {
        queries,
        resultsPerPage: maxResultsPerQuery,
        maxPagesPerQuery: 1,
      },
      searchActorId()
    );
  } catch (err) {
    throw new Error(
      `Apify research failed (${err instanceof Error ? err.message : String(err)}). ` +
        `Check APIFY_TOKEN and APIFY_SEARCH_ACTOR_ID (currently "${searchActorId()}").`
    );
  }

  const sources: ResearchSource[] = [];
  for (const item of items) {
    const organic: any[] = item.organicResults ?? item.results ?? [];
    for (const r of organic.slice(0, maxResultsPerQuery)) {
      sources.push({
        title: r.title ?? "",
        description: r.description ?? r.snippet ?? "",
        url: r.link ?? r.url ?? "",
      });
    }
  }
  return sources.filter((s) => s.title || s.description).slice(0, 15);
}
/** yt-dlp fallback: title/duration straight off the URL. */
async function metadataFromYtdlp(url: string) {
  const meta = await probeMetadata(url);
  if (!meta) return null;
  return {
    title: firstString(meta.title) || "Untitled video",
    durationSec: firstNumber(meta.duration),
  };
}

export interface IntelResult {
  intel: VideoIntel;
  /** Where the transcript came from — "none" means Deepgram handles it later. */
  transcriptSource: "apify" | "captions" | "none";
  /** Non-fatal notes worth showing the user. */
  warnings: string[];
}

/**
 * Builds the `VideoIntel` for a pasted video URL: title, duration, word-level
 * transcript and (when the actor provides them) scene cuts.
 *
 * The video FILE is not downloaded here — `videoFilePath` is left empty and
 * /api/render pulls the pixels lazily through yt-dlp.
 *
 * Resilient by design: if the Apify actor omits title or duration, yt-dlp may
 * provide metadata. Caption scraping is deliberately not a fallback here:
 * yt-dlp can spend five minutes waiting on YouTube's bot check from cloud IPs.
 * Missing transcripts are handled later by Deepgram or visual-only planning.
 */
export async function fetchVideoIntel(url: string): Promise<IntelResult> {
  const sourceUrl = url.trim();
  if (!sourceUrl) throw new Error("No video URL was provided.");
  if (!/^https?:\/\//i.test(sourceUrl)) {
    throw new Error(`"${sourceUrl}" is not a valid http(s) URL.`);
  }

  const warnings: string[] = [];
  let title = "";
  let durationSec: number | undefined;
  let sceneCuts: number[] | undefined;
  let transcript: TranscriptWord[] = [];
  let transcriptSource: IntelResult["transcriptSource"] = "none";

  // --- Primary: the Apify actor -------------------------------------------
  try {
    const items = await runActor({
      startUrls: [{ url: sourceUrl }],
      videoUrl: sourceUrl,
      maxItems: 1,
      includeTranscript: true,
      getSubtitles: true,
    });

    if (items.length === 0) {
      warnings.push(
        "The Apify actor returned no data for this link — used yt-dlp metadata and " +
          "captions instead. Check that APIFY_YOUTUBE_ACTOR_ID is a YouTube actor that " +
          "accepts a startUrls input."
      );
    } else {
      const mapped = mapItem(items[0]);
      title = mapped.title;
      durationSec = mapped.durationSec;
      sceneCuts = mapped.sceneCuts;
      transcript = await extractTranscript(items[0]);
      if (transcript.length) transcriptSource = "apify";
    }
  } catch (err) {
    warnings.push(
      `Apify could not fetch this video (${err instanceof Error ? err.message : String(err)}) — ` +
        `trying a metadata-only yt-dlp fallback.`
    );
  }

  // --- Fallback: yt-dlp ----------------------------------------------------
  if (!title || durationSec === undefined) {
    const fallback = await metadataFromYtdlp(sourceUrl);
    if (fallback) {
      title = title || fallback.title;
      durationSec = durationSec ?? fallback.durationSec;
    }
  }
  if (!transcript.length) {
    warnings.push(
      "The Apify actor returned no transcript. yt-dlp caption scraping was skipped to avoid " +
        "YouTube cloud-IP bot-check delays. With DEEPGRAM_API_KEY, transcription runs at " +
        "edit-plan time; otherwise the planner uses visual-only analysis."
    );
  }

  const intel: VideoIntel = {
    sourceUrl,
    title: title || "Untitled video",
    durationSec: durationSec ?? 0,
    videoFilePath: "", // lazy — /api/render downloads it via yt-dlp
    transcript,
    ...(sceneCuts?.length ? { sceneCuts } : {}),
  };

  return { intel, transcriptSource, warnings };
}

/** Coerce a direct media URL out of a downloader actor's dataset item. */
function pickDownloadUrl(item: any): string | null {
  if (!item || typeof item !== "object") return null;
  const isHttp = (s: any) => typeof s === "string" && /^https?:\/\//i.test(s);

  // Explicit "download"/"mp4" fields first, then generic.
  const preferred = [
    "downloadUrl", "videoDownloadUrl", "mp4Url", "mp4", "directUrl",
    "mediaUrl", "fileUrl", "download_url", "video_url", "url", "link", "videoUrl",
  ];
  for (const k of preferred) {
    const v = (item as any)[k];
    if (isHttp(v)) return v as string;
    if (v && typeof v === "object" && isHttp(v.url)) return v.url;
  }

  // Some actors return a list of formats/streams instead of one URL.
  for (const list of [item.formats, item.streams, item.video, item.media]) {
    if (!Array.isArray(list)) continue;
    const mp4 = list.find((f: any) => f && isHttp(f.url) && /\.mp4(\?|$)/i.test(f.url));
    const any = list.find((f: any) => f && isHttp(f.url));
    const chosen = mp4 ?? any;
    if (chosen?.url) return String(chosen.url);
  }
  return null;
}

function safeSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

function normalizeVideoExt(raw: string): string {
  const e = (raw || "").toLowerCase();
  return [".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi"].includes(e) ? e : ".mp4";
}

/**
 * Downloads the actual video FILE through a configurable Apify downloader actor
 * and streams it to `<outDir>/<outName><ext>`, returning the local path.
 *
 * This is the Apify path that does the real "get the video" work you asked for,
 * for YouTube AND any site: it runs a video-downloader actor (which returns a
 * direct media URL), then fetches that URL to disk. Callers fall back to yt-dlp
 * when this throws (actor unconfigured, run failed, or no media URL returned).
 *
 *   APIFY_VIDEO_DOWNLOADER_ACTOR_ID    primary YouTube downloader actor
 *   APIFY_YOUTUBE_DOWNLOADER_ACTOR_ID  legacy YouTube-specific alias
 *   APIFY_GENERAL_DOWNLOADER_ACTOR_ID   any-site downloader actor (for other links)
 *   APIFY_DOWNLOADER_ACTOR_ID           shared fallback for either
 *
 * Popular choices (paste the id, not the URL):
 *   YouTube:  convertfleetdotonline~youtube-downloader  (or wyuhhqn~youtube-video-downloader)
 *   Any site: klzzixjdksonskaplaif~video-downloader
 */
export async function downloadVideoFileViaApify(opts: {
  url: string;
  outDir: string;
  outName: string;
  timeoutMs?: number;
}): Promise<string> {
  const { url, outDir, outName, timeoutMs = 20 * 60_000 } = opts;
  const sourceUrl = url.trim();
  const videoId = extractVideoId(sourceUrl);

  const platformActor = videoId
    ? process.env.APIFY_VIDEO_DOWNLOADER_ACTOR_ID ??
      process.env.APIFY_YOUTUBE_DOWNLOADER_ACTOR_ID
    : process.env.APIFY_GENERAL_DOWNLOADER_ACTOR_ID;
  const actorId =
    (platformActor ?? "").trim() || (process.env.APIFY_DOWNLOADER_ACTOR_ID ?? "").trim();

  if (!actorId) {
    throw new Error(
      "No Apify video-downloader actor is configured. Set APIFY_VIDEO_DOWNLOADER_ACTOR_ID " +
        "to a downloader actor id from the Apify Store, for example " +
        "boztek-ltd~youtube-downloader."
    );
  }

  const actorInput = actorId.toLowerCase().includes("boztek-ltd~youtube-downloader")
    ? {
        startUrls: [{ url: sourceUrl }],
        downloadType: "video",
        quality: "720p",
        maxConcurrency: 1,
      }
    : {
        startUrls: [{ url: sourceUrl }],
        url: sourceUrl,
        videoUrl: sourceUrl,
        videoUrls: [sourceUrl],
        maxItems: 1,
      };

  const items = await runActor(
    actorInput,
    actorId
  );
  if (!items.length) {
    throw new Error("The Apify video-downloader actor returned no data for this URL.");
  }
  const result = items.find((item) => String(item?.status ?? "").toUpperCase() === "SUCCESS") ?? items[0];
  if (String(result?.status ?? "").toUpperCase() === "FAILED") {
    throw new Error(`The Apify video-downloader actor failed: ${String(result?.error ?? "no reason provided")}`);
  }
  const downloadUrl = pickDownloadUrl(result);
  if (!downloadUrl) {
    throw new Error(
      `The Apify video-downloader actor returned no downloadUrl. ` +
        `Check its run output; first result keys: ${Object.keys(result ?? {}).join(", ") || "none"}.`
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  const ext = normalizeVideoExt(path.extname(new URL(downloadUrl).pathname));
  const target = path.join(outDir, `${outName}${ext}`);

  const res = await fetch(downloadUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) {
    throw new Error(
      `Fetching the video from Apify's download URL failed (HTTP ${res.status}).`
    );
  }

  const { Readable } = await import("stream");
  const { pipeline } = await import("stream/promises");
  const tmp = `${target}.part`;
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
  fs.renameSync(tmp, target);

  if (safeSize(target) < 100_000) {
    throw new Error(
      `The Apify download URL produced only ${safeSize(target)} bytes — not a usable video.`
    );
  }
  return target;
}