import { NextResponse } from "next/server";
import { DEPLOYED_HOST, isPublicBaseUrl, publicOrigin } from "../../../lib/tunnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Configuration diagnostics for a live deployment — answers the only question
 * that matters when a deploy misbehaves: "does the app actually SEE my env
 * vars, or did they land as placeholders?"
 *
 * Booleans and shape checks ONLY — never a value, never a secret. Safe to hit
 * anonymously (it is on middleware's PUBLIC_API list).
 *
 * GET /api/health
 */
export async function GET() {
  const v = (name: string) => process.env[name]?.trim() || "";
  // A value is a leftover template when it still contains angle brackets,
  // ellipses or the "your_…"/example words from .env.local.example.
  const looksPlaceholder = (s: string) =>
    !s || /<|>|\.\.\.|your[_-]|example|placeholder/i.test(s);
  const isJwt = (s: string) => /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(s);

  const url = v("NEXT_PUBLIC_SUPABASE_URL");
  const anon = v("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const service = v("SUPABASE_SERVICE_ROLE_KEY");
  const paySecret = v("PAYSTACK_SECRET_KEY");
  const payPublic = v("NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY");
  const base = v("NEXT_PUBLIC_BASE_URL");

  const report = {
    runtime: {
      deployed: DEPLOYED_HOST,
      nodeEnv: process.env.NODE_ENV,
      learnedPublicOrigin: publicOrigin(),
    },
    config: {
      NEXT_PUBLIC_SUPABASE_URL: {
        set: !!url,
        placeholder: looksPlaceholder(url),
        looksLikeSupabase: /^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url),
      },
      NEXT_PUBLIC_SUPABASE_ANON_KEY: {
        set: !!anon,
        placeholder: looksPlaceholder(anon),
        isJwt: isJwt(anon),
        isAnonRole: jwtRole(anon) === "anon",
      },
      SUPABASE_SERVICE_ROLE_KEY: {
        set: !!service,
        placeholder: looksPlaceholder(service),
        isJwt: isJwt(service),
        // Only says WHICH role the key carries — not the key itself.
        role: jwtRole(service) || null,
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
    hint:
      "Every `placeholder: true` means the Railway variable still holds the " +
      "template text, not your real key. NEXT_PUBLIC_* values are baked in at " +
      "BUILD time — after fixing a variable, trigger a full redeploy, not just " +
      "a restart.",
  };

  return NextResponse.json(report, { headers: { "cache-control": "no-store" } });
}

/** Decode just enough of a JWT payload to read its `role` claim. */
function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const b64 = token.split(".")[1] ?? "";
    const json = Buffer.from(
      b64.replace(/-/g, "+").replace(/_/g, "/"),
      "base64"
    ).toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function jwtRole(token: string): string | null {
  const r = jwtPayload(token)?.role;
  return typeof r === "string" ? r : null;
}