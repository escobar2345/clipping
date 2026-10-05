import { NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";

/**
 * Signs the user out and clears the Supabase session cookies.
 *
 * POST only — a GET sign-out can be triggered by any image tag on a page, which
 * would let a third-party site log your users out at will.
 */
export const runtime = "nodejs";

export async function POST(request: Request) {
  const supabase = createClient();
  await supabase.auth.signOut();

  const origin = new URL(request.url).origin;
  return NextResponse.redirect(`${origin}/login`, { status: 303 });
}