import { NextResponse } from "next/server";
import { destroySession } from "../../../../lib/authContext";

/**
 * JSON sign-out endpoint the studio UI calls (`/api/auth/signout`).
 *
 * Canonical sign-out lives at `/auth/signout` (POST → 303 redirect). This
 * alias exists so fetch() callers get JSON instead of following a redirect to
 * HTML. Both delete the `sessions` row and clear the same `l2s_session` cookie.
 */
export const runtime = "nodejs";

export async function POST() {
  // destroySession clears the cookie even if the DB is briefly unreachable,
  // so sign-out never strands the browser on a dead session.
  await destroySession();
  return NextResponse.json({ ok: true });
}
