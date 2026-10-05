import { NextRequest, NextResponse } from "next/server";
import { verifyTransaction } from "../../../../lib/paystack";
import { findUserIdByEmail, recordPayment } from "../../../../lib/billing";

/**
 * Paystack webhook — the source of truth for "this user paid".
 *
 * Paystack does NOT sign webhooks, so we never trust the payload: we take only
 * the reference and re-fetch the transaction from Paystack's API. If Paystack
 * says `status === "success"` and the amount matches, the plan is granted.
 *
 * Configure the URL in dashboard.paystack.com → Settings → API Keys → Webhooks
 * (use your deployed URL, not localhost). Paystack retries until you return 2xx.
 */
export const runtime = "nodejs";

/** One month from now — Paystack subscriptions here are monthly. */
function nextPeriodEnd(): string {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

/** Expected amounts, so a tampered/partial payment can't grant a plan. */
const EXPECTED: Record<string, number> = {
  creator: 500000,
  pro: 1500000,
};

export async function POST(req: NextRequest) {
  try {
    const payload: any = await req.json().catch(() => null);

    const reference: string | undefined =
      payload?.data?.reference ?? payload?.reference ?? undefined;
    if (!reference) {
      return NextResponse.json({ error: "No reference in payload." }, { status: 400 });
    }

    // Only act on the events that mean money actually changed hands.
    const event: string = payload?.event ?? "";
    if (event && !["charge.success", "subscription.create", "invoice.update"].includes(event)) {
      return NextResponse.json({ received: true, ignored: event });
    }

    const tx = await verifyTransaction(reference);
    if (!tx || tx.status !== "success") {
      // Not a completed payment — acknowledge so Paystack stops retrying.
      return NextResponse.json({ received: true, status: tx?.status ?? "unknown" });
    }

    const meta = tx.metadata ?? {};
    const planId = String(meta.plan ?? "");
    const expected = EXPECTED[planId];
    if (!expected) {
      return NextResponse.json({ error: `Unknown plan in metadata: ${planId || "(none)"}` }, { status: 400 });
    }
    if (Math.round(tx.amount) !== expected) {
      return NextResponse.json(
        { error: `Amount mismatch: paid ${tx.amount}, expected ${expected} for ${planId}.` },
        { status: 400 }
      );
    }

    // Prefer the user id we stamped at checkout; fall back to the paid email.
    let userId: string | null =
      typeof meta.user_id === "string" && meta.user_id.length > 0 ? meta.user_id : null;
    if (!userId && tx.email) {
      userId = await findUserIdByEmail(tx.email);
    }
    if (!userId) {
      return NextResponse.json(
        { error: "Could not match this payment to a Long2Short account." },
        { status: 400 }
      );
    }

    await recordPayment({ userId, plan: planId, reference, periodEnd: nextPeriodEnd() });

    return NextResponse.json({ received: true, plan: planId });
  } catch (err: any) {
    // 500 so Paystack retries — a transient DB hiccup shouldn't lose a payment.
    return NextResponse.json({ error: err?.message ?? "Webhook failed." }, { status: 500 });
  }
}