import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser-side Supabase client.
 *
 * Uses the PUBLIC anon key — safe to ship to the browser because Supabase's
 * Row Level Security is what actually protects the data. Never put the
 * service-role key in anything a client imports.
 */
export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local (see .env.local.example) " +
        "and restart the dev server."
    );
  }

  return createBrowserClient(url, anonKey);
}