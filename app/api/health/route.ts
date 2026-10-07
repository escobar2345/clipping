import { NextRequest, NextResponse } from "next/server";
import { DEPLOYED_HOST, isPublicBaseUrl, publicOrigin } from "../../../lib/tunnel";
import { checkDatabase } from "../../../lib/db";
import { ensureTables } from "../../../lib/dbInit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Configuration diagnostics for a live deployment — answers the only question
 * that matters when a deploy misbehaves: "does the app actually SEE my env
 * vars, or did they land as placeholders? Is Postgres reachable?"
 *
 * Booleans and shape checks ONLY — never a value, never a secret. Safe to hit
 * anonymously (it is on middleware's PUBLIC_API list).
 *
 * GET /api/health          → report
 * GET /api/health?migrate=1 → re-run table creation first, then report
 */
export async function GET(req: NextRequest) {
  const v = (name: string) => process.env[name]?.trim() || "";
  // A value is a leftover template when it still contains angle brackets,
  // ellipses or the "your_…"/example words from .env.local.example.
  const looksPlaceholder = (s: string) =>
    !s || /<|>|\.\.\.|your[_-]|example|placeholder/i.test(s);

  const dbUrl = v("DATABASE_URL");
  const pgHost = v("PGHOST");
  const paySecret = v("PAYSTACK_SECRET_KEY");
  const payPublic = v("NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY");
  const base = v("NEXT_PUBLIC_BASE_URL");

  // Escape hatch: force the `create table if not exists` pass to run again
  // (ensureTables caches success in-process, so this is the way to re-check
  // after fixing DATABASE_URL without restarting).
  let migrated: boolean | null = null;
  if (req.nextUrl.searchParams.get("migrate") === "1") {
    await ensureTables();
    migrated = true;
  }

  const db = await checkDatabase();

  const report = {
    runtime: {
      deployed: DEPLOYED_HOST,
      nodeEnv: process.env.NODE_ENV,
      learnedPublicOrigin: publicOrigin(),
    },
    config: {
      DATABASE_URL: {
        set: !!dbUrl,
        placeholder: looksPlaceholder(dbUrl),
        // Host only, never credentials — enough to spot a wrong var.
        host: dbUrl ? safeHost(dbUrl) : null,
      },
      PGHOST: {
        set: !!pgHost,
        placeholder: looksPlaceholder(pgHost),
      },
      PAYSTACK_SECRET_KEY: {
        set: !!paySecret,
        placeholder: looksPlaceholder(paySecret),
        isTestOrLive: /^sk_(test|live)_/.test(paySecret),
      },
      NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY: {
        set: !!payPublic,
        placeholder: looksPlaceholder(payPublic),
        isTestOrLive: /^pk_(test|live)_/.test(payPublic),
      },
      NEXT_PUBLIC_BASE_URL: {
        set: !!base,
        placeholder: looksPlaceholder(base),
        isPublic: isPublicBaseUrl(base),
        value: base || null, // public by design (it's the site's own URL)
      },
    },
    database: {
      configured: !!(dbUrl || pgHost),
      reachable: db.ok,
      error: db.ok ? null : db.error,
      migrated,
    },
    hint:
      "Every `placeholder: true` means the Railway variable still holds the " +
      "template text, not your real key. NEXT_PUBLIC_* values are baked in at " +
      "BUILD time — after fixing a variable, trigger a full redeploy, not just " +
      "a restart. DATABASE_URL is read at runtime, so fixing it only needs a " +
      "restart (or ?migrate=1 for the tables).",
  };

  return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}

/** Extracts just the host from a Postgres URL — never the password. */
function safeHost(url: string): string | null {
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}