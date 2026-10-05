import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { requireAuth } from "../../../../lib/authContext";
import { getPlan, initializeTransaction } from "../../../../lib/paystack";

/**
 * Starts a Paystack checkout for a plan.
 *
 * Body: { plan: "creator" | "pro" }
 * Response: { authorizationUrl } — Paystack's hosted page; the browser
 * navigates there and Paystack redirects back to /billing?reference=…
 *
 * We generate the reference ourselves and stamp plan + user into the metadata
 * so the webhook can attribute the payment without trusting the browser.
 */
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAuth();

    let body: { plan?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const plan = getPlan((body.plan ?? "").trim());
    if (plan.id === "free") {
      return NextResponse.json({ error: "Choose a paid plan." }, { status: 400 });
    }

    const origin =
      process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/+$/, "") ||
      new URL(req.url).origin;

    const reference = `l2s_${ctx.userId.slice(0, 8)}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

    const tx = await initializeTransaction({
      email: ctx.email,
      reference,
      amount: plan.amount,
      currency: plan.currency,
      callbackUrl: `${origin}/billing?reference=${encodeURIComponent(reference)}`,
      metadata: { user_id: ctx.userId, email: ctx.email, plan: plan.id },
      planCode: process.env.PAYSTACK_PLAN_CODE || undefined,
    });

    return NextResponse.json({
      authorizationUrl: tx.authorization_url,
      reference: tx.reference,
    });
  } catch (err: any) {
    const status = err?.status ?? 500;
    return NextResponse.json({ error: err?.message ?? "Could not start checkout." }, { status });
  }
}