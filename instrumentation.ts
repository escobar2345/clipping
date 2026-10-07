/**
 * Next.js instrumentation — runs once when the server process boots
 * (enabled via experimental.instrumentationHook in next.config.mjs).
 *
 *   1. patchDnsLookup()  — public-DNS-first resolution for EVERY outbound
 *      connection (the local router's resolver intermittently SERVFAILs;
 *      see lib/resilientDns.ts).
 *   2. ensureTables()    — create the users/sessions/subscriptions/usage_events
 *      tables if they don't exist yet, so a fresh Railway Postgres volume
 *      self-heals instead of 500ing every auth call.
 */
export async function register(): Promise<void> {
  // NOTE: keep this a POSITIVE `=== "nodejs"` check. Next compiles
  // instrumentation.ts for the edge runtime too, and webpack only prunes the
  // branch (and its node-only imports) when the guard is a compile-time-false
  // `if (false) { … }` — an early-return `!==` leaves them reachable.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { patchDnsLookup } = await import("./lib/resilientDns");
      patchDnsLookup();
    } catch (err: any) {
      console.warn(`[boot] DNS patch failed: ${err?.message ?? err}`);
    }
    try {
      const { ensureTables } = await import("./lib/dbInit");
      await ensureTables();
    } catch (err: any) {
      console.warn(`[boot] table check failed: ${err?.message ?? err}`);
    }
  }
}