import { NextResponse } from "next/server";
import { createClient } from "../../../lib/supabase/server";

/**
 * Where Supabase sends the browser back after an OAuth login or an emailed
 * confirmation click. Exchanges the one-time code for a session cookie, then
 * forwards to the app (or the page the user originally asked for).
 *
 * Runs on the Node runtime because it reads/writes cookies.
 */
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  // Only ever redirect within this app — an open redirect here would let a
  // crafted link bounce a freshly-signed-in user to an attacker's site.
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  try {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
  } catch {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  return NextResponse.redirect(`${origin}${safeNext}`);
}