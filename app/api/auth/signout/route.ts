import { NextResponse } from "next/server";
import { createClient } from "../../../../lib/supabase/server";

/**
 * JSON sign-out endpoint the studio UI calls (`/api/auth/signout`).
 *
 * Canonical sign-out lives at `/auth/signout` (POST → 303 redirect). This
 * alias exists so fetch() callers get JSON instead of following a redirect to
 * HTML. Both clear the same Supabase session cookies.
 */
export const runtime = "nodejs";

export async function POST() {
  const supabase = createClient();
  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}
