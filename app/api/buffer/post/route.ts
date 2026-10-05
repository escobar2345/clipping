import { NextResponse } from "next/server";
import { withAuth } from "../../../../lib/withAuth";
import { postToBufferTargets } from "../../../../lib/bufferPost";

export const runtime = "nodejs";

/**
 * Posts one rendered clip to MANY channels across MANY Buffer accounts
 * SIMULTANEOUSLY. Each target resolves to its own saved account credentials,
 * then every post request fires in parallel — one account failing or
 * rate-limiting never blocks the others.
 *
 * Body: { renderedPath, targets: [{ accountId, channelId, caption?, service?,
 *         postType? }], caption, mode, dueAtIso }
 *
 * The actual fan-out lives in lib/bufferPost.ts so the chat assistant's
 * post_to_buffer action runs byte-identical code.
 *
 * Only THIS user's Buffer accounts are reachable — postToBufferTargets reads
 * data/users/<userId>/accounts.json.
 */
export const POST = withAuth(
  async (req: Request) => {
  try {
    const { renderedPath, targets, caption, mode, dueAtIso } = await req.json();
    const data = await postToBufferTargets({
      renderedPath,
      targets,
      caption,
      mode,
      dueAtIso,
    });
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message ?? "Failed to post to Buffer" }, { status: 500 });
  }
  },
  // Posting is a paid capability — it spends the user's Buffer connections and
  // publishes publicly on their behalf.
  { plan: "paid" }
);
