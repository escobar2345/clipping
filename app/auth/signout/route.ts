import { NextResponse } from "next/server";
import { destroySession } from "../../../lib/authContext";

/**
 * Signs the user out: deletes the `sessions` row and clears the
 * `l2s_session` cookie.
 *
 * POST only — a GET sign-out can be triggered by any image tag on a page, which
 * would let a third-party site log your users out at will.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  await destroySession();

  const origin = new URL(request.url).origin;
  return NextResponse.redirect(`${origin}/login`, { status: 303 });
}