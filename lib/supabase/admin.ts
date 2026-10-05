import { createClient } from "@supabase/supabase-js";

/**
 * Supabase client using the SERVICE ROLE key — bypasses Row Level Security.
 *
 * ONLY for trusted server work that cannot use the user's own token:
 *   - the Paystack webhook (fires with no user session)
 *   - admin lookups by email
 * Never import this from a file that runs in the browser, and never prefix it
 * with NEXT_PUBLIC_ — that key grants full access to every table.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local " +
        "(Supabase dashboard → Project Settings → API)."
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}