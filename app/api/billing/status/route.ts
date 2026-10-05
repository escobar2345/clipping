import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "../../../../lib/authContext";
import { getSubscription, isPaid, remainingVideoQuota } from "../../../../lib/billing";
import { PLANS, PLAN_VIDEO_LIMITS, verifyTransaction } from "../../../../lib/paystack";
import { recordPayment } from "../../../../lib/billing";

/**
 * GET  → current plan, quota, and the full catalogue for the pricing UI.
 * POST → confirm a payment right after the browser returns from Paystack.
 *
 * The POST is a convenience, not the source of truth: it re-verifies the
 * transaction with Paystack (never trusts the query string) and is idempotent
 * because recordPayment upserts on user_id. The webhook does the same work, so
 * a missed webhook still leaves the user upgraded.
 */
export const runtime = "nodejs";

export async function GET() {
  try {
    const ctx = await requireAuth();
    const sub = await getSubscription();
    const remaining = await remainingVideoQuota(sub);

    return NextResponse.json({
      plan: sub,
      paid: isPaid(sub),
      remainingVideos: Number.isFinite(remaining) ? remaining : null, // null = unlimited
      plans: Object.values(PLANS),
      limits: PLAN_VIDEO_LIMITS,
      email: ctx.email,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Could not read your plan." },
      { status: err?.status ?? 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireAuth();

    let body: { reference?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const reference = (body.reference ?? "").trim();
    if (!reference) {
      return NextResponse.json({ error: "A payment reference is required." }, { status: 400 });
    }

    const tx = await verifyTransaction(reference);
    if (!tx) {
      return NextResponse.json({ error: "Paystack has no record of that payment." }, { status: 404 });
    }
    if (tx.status !== "success") {
      return NextResponse.json({ error: `That payment is ${tx.status}.` }, { status: 400 });
    }

    // Only accept payments that belong to this signed-in user.
    const paidFor: string = String(tx.metadata?.user_id ?? "");
    const paidEmail: string = String(tx.email ?? "").toLowerCase();
    if (paidFor !== ctx.userId && paidEmail !== ctx.email.toLowerCase()) {
      return NextResponse.json({ error: "That payment belongs to another account." }, { status: 403 });
    }

    const planId = String(tx.metadata?.plan ?? "");
    const plan = PLANS[planId as keyof typeof PLANS];
    if (!plan || plan.amount !== Math.round(tx.amount)) {
      return NextResponse.json({ error: "That payment doesn't match a known plan." }, { status: 400 });
    }

    const periodEnd = new Date();
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);

    await recordPayment({
      userId: ctx.userId,
      plan: plan.id,
      reference,
      periodEnd: periodEnd.toISOString(),
    });

    return NextResponse.json({ ok: true, plan: plan.id });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Could not confirm the payment." },
      { status: err?.status ?? 500 }
    );
  }
}