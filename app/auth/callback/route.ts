import { NextResponse } from "next/server";

/**
 * Legacy OAuth/email-confirmation callback.
 *
 * The app now owns auth entirely (email + password against Postgres — see
 * lib/authContext.ts), so there is no provider round-trip to complete here.
 * This route survives only so old confirmation links and bookmarked
 * `?code=…` URLs land somewhere sane instead of a 404.
 *
 * Runs on the Node runtime because it reads/writes cookies.
 */
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { origin } = new URL(request.url);
  return NextResponse.redirect(`${origin}/login`);
}