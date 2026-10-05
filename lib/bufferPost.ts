// Shared Buffer fan-out core, used by /api/buffer/post AND the chat
// assistant's post_to_buffer action — one code path so a post behaves
// identically whether it is clicked or spoken.

import { createVideoPost } from "./buffer";
import { getAccount } from "./accounts";
import { getPublicBaseUrl } from "./tunnel";

export interface PostTarget {
  accountId: string;
  channelId: string;
  /** Optional per-platform caption override; falls back to the shared caption. */
  caption?: string;
  /** Channel service name ("instagram", "tiktok", …) as shown in the UI —
   *  used to pick the correct per-service post metadata. */
  service?: string;
  /** "story" | "reel" — Buffer's Instagram post type. Only applied to
   *  Instagram channels; Buffer's API exposes no TikTok story type. */
  postType?: string;
}

/** Build the CreatePostInput.metadata that posts an Instagram channel to
 *  Stories ("story") or as a Reel ("reel"). Both require Buffer's
 *  `shouldShareToFeed` flag. Returns null when the requested type isn't a
 *  supported Instagram type. */
export function instagramMetadata(postType: string | undefined): Record<string, any> | null {
  if (postType === "story") return { instagram: { type: "story", shouldShareToFeed: false } };
  if (postType === "reel") return { instagram: { type: "reel", shouldShareToFeed: true } };
  return null;
}

/**
 * Posts one rendered clip to MANY channels across MANY Buffer accounts
 * SIMULTANEOUSLY. Each target resolves to its own saved account credentials,
 * then every post request fires in parallel via Promise.allSettled — one
 * account failing or rate-limiting never blocks the others.
 *
 * input: { renderedPath, targets: [{ accountId, channelId, caption?, service?,
 *         postType? }], caption, mode, dueAtIso }
 */
export async function postToBufferTargets(input: {
  renderedPath: string;
  targets: PostTarget[];
  caption: string;
  mode: "queue" | "schedule";
  dueAtIso?: string;
}) {
  const { renderedPath, targets, caption, mode, dueAtIso } = input;

  if (!renderedPath || !caption || !mode) {
    throw new Error("renderedPath, caption, and mode are required");
  }
  const targetList: PostTarget[] = Array.isArray(targets) ? targets : [];
  if (targetList.length === 0) {
    throw new Error("targets must be a non-empty array of { accountId, channelId }");
  }

  // Buffer fetches media from a public URL — it has no upload endpoint — and
  // that URL has to stay reachable until the post actually publishes, not just
  // at the moment you call this route. getPublicBaseUrl() makes the app come
  // online BY ITSELF: it trusts NEXT_PUBLIC_BASE_URL when the video answers
  // through it (the production path), otherwise it spins up / reuses an ngrok
  // tunnel so local dev works and Buffer never sees a localhost URL.
  let baseUrl: string;
  try {
    baseUrl = await getPublicBaseUrl(renderedPath);
  } catch (err: any) {
    throw new Error(err.message ?? "No public URL is available for the video");
  }
  const videoUrl = `${baseUrl.replace(/\/$/, "")}${renderedPath}`;

  // Resolve every referenced account up front (tokens stay server-side).
  const accountCache = new Map<string, Awaited<ReturnType<typeof getAccount>>>();
  for (const t of targetList) {
    if (!accountCache.has(t.accountId)) {
      accountCache.set(t.accountId, await getAccount(t.accountId));
    }
  }

  // Fan out — all posts fire concurrently across all accounts.
  const settled = await Promise.all(
    targetList.map(async (t) => {
      try {
        const account = accountCache.get(t.accountId);
        if (!account) throw new Error(`Unknown account: ${t.accountId}`);

        const post = await createVideoPost(
          {
            channelId: t.channelId,
            text: t.caption?.trim() || caption,
            videoUrl,
            mode,
            dueAtIso,
            // Only Instagram exposes story/reel through Buffer's API (their
            // TikTokPostMetadataInput has no `type`) — ignore postType for
            // every other service so a stray UI flag can't corrupt a
            // TikTok/YouTube/Facebook post.
            metadata: (t.service ?? "").toLowerCase().includes("instagram")
              ? instagramMetadata(t.postType) ?? undefined
              : undefined,
          },
          account.accessToken
        );

        return { accountId: t.accountId, channelId: t.channelId, ok: true as const, post };
      } catch (err: any) {
        return {
          accountId: t.accountId,
          channelId: t.channelId,
          ok: false as const,
          error: err.message ?? "Post failed",
        };
      }
    })
  );

  const succeeded = settled.filter((r) => r.ok);
  const failed = settled.filter((r) => !r.ok);

  return {
    results: settled,
    publicBaseUrl: baseUrl,
    summary: {
      total: settled.length,
      succeeded: succeeded.length,
      failed: failed.length,
    },
  };
}