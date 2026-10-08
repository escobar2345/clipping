import { getPool } from "./db";
import { PLANS, PLAN_VIDEO_LIMITS, type PaystackPlan } from "./paystack";
import { getAuthContext, UnauthorizedError, findUserByEmail } from "./authContext";

/**
 * Subscriptions live in the app's own Postgres (Railway addon) so they survive
 * a redeploy and are shared across every instance of the app (unlike the
 * per-user files on disk, which are local to one machine).
 *
 * Table: `subscriptions` (see db/schema.sql)
 *   user_id       uuid primary key, references users
 *   plan          text   — 'free' | 'creator' | 'pro'
 *   status        text   — 'active' | 'cancelled' | 'expired'
 *   paystack_ref  text   — last Paystack transaction reference
 *   current_period_end timestamptz
 *   updated_at    timestamptz
 */

export interface Subscription {
  plan: PaystackPlan["id"];
  status: "active" | "cancelled" | "expired";
  currentPeriodEnd: string | null;
}

export const FREE_SUBSCRIPTION: Subscription = {
  plan: "free",
  status: "active",
  currentPeriodEnd: null,
};

/**
 * The signed-in user's subscription. A user with no row (or an expired one)
 * falls back to the free plan rather than erroring — so a database hiccup
 * degrades to "free tier", never to a broken app.
 */
export async function getSubscription(): Promise<Subscription | null> {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  try {
    const { rows } = await getPool().query<{
      plan: string;
      status: string;
      current_period_end: string | null;
    }>(
      "select plan, status, current_period_end from public.subscriptions where user_id = $1 limit 1",
      [ctx.userId]
    );
    const data = rows[0];
    if (!data) return { ...FREE_SUBSCRIPTION };
    return {
      plan: (PLANS[data.plan as PaystackPlan["id"]] ? data.plan : "free") as PaystackPlan["id"],
      status: (data.status ?? "active") as Subscription["status"],
      currentPeriodEnd: data.current_period_end ?? null,
    };
  } catch (err: any) {
    throw new Error(`Could not load your subscription: ${err?.message ?? err}`);
  }
}

/** Plans that grant access at all (everything except free). */
export function isPaid(sub: Subscription | null): boolean {
  if (!sub) return false;
  if (sub.plan === "free") return false;
  if (sub.status === "expired") return false;
  // A cancelled plan keeps working until the period actually ends.
  if (sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) < new Date() && sub.status === "cancelled") {
    return false;
  }
  return true;
}

/** Thrown when a signed-in user tries to use a paid feature. */
export class PaymentRequiredError extends Error {
  readonly status = 402;
  constructor(message: string) {
    super(message);
    this.name = "PaymentRequiredError";
  }
}

/**
 * Gate for a paid capability. Returns the subscription when the user is on a
 * paid plan, throws PaymentRequiredError otherwise.
 */
export async function requirePaidPlan(feature: string): Promise<Subscription> {
  const sub = await getSubscription();
  if (isPaid(sub)) return sub as Subscription;
  throw new PaymentRequiredError(
    `${feature} needs a paid plan. Choose a plan to continue — you're on the free tier.`
  );
}

/**
 * Videos analysed this billing month. Counts rows the user owns, so it can't be
 * inflated by another account. Returns Infinity for unlimited plans.
 */
export async function remainingVideoQuota(sub: Subscription | null): Promise<number> {
  // NOTE: plan limits are `number | null` where null = unlimited — do NOT
  // coalesce null to 0 here, that would report Pro as "0 left" and 402 every
  // request. Check for null BEFORE any numeric handling.
  const limit = PLAN_VIDEO_LIMITS[(sub?.plan ?? "free") as PaystackPlan["id"]];
  if (limit == null) return Infinity; // unlimited (pro)
  if (limit === 0) return limit;

  const ctx = await getAuthContext();
  if (!ctx) return 0;

  try {
    const since = new Date();
    since.setUTCDate(1); // start of the current calendar month
    since.setUTCHours(0, 0, 0, 0);

    const { rows } = await getPool().query<{ count: string }>(
      "select count(*)::text as count from public.usage_events where user_id = $1 and kind = 'analyze' and created_at >= $2",
      [ctx.userId, since.toISOString()]
    );
    const count = Number(rows[0]?.count ?? 0);
    if (!Number.isFinite(count)) return limit;
    return Math.max(0, limit - count);
  } catch {
    return limit;
  }
}

/** Records one video analysis against the user's monthly quota. */
export async function recordAnalyzeEvent(): Promise<void> {
  const ctx = await getAuthContext();
  if (!ctx) return;
  try {
    await getPool().query("insert into public.usage_events (user_id, kind) values ($1, 'analyze')", [
      ctx.userId,
    ]);
  } catch {
    // Usage tracking must never block the actual work.
  }
}

/**
 * Records a confirmed Paystack payment. Called from the webhook (no user
 * session), so it writes by user id directly — no RLS concept here because
 * the route verifies the Paystack signature before calling.
 */
export async function recordPayment(args: {
  userId: string;
  plan: string;
  reference: string;
  periodEnd?: string | null;
}): Promise<void> {
  try {
    await getPool().query(
      "insert into public.subscriptions (user_id, plan, status, paystack_ref, current_period_end, updated_at) values ($1, $2, 'active', $3, $4, now()) on conflict (user_id) do update set plan = excluded.plan, status = 'active', paystack_ref = excluded.paystack_ref, current_period_end = excluded.current_period_end, updated_at = now()",
      [args.userId, args.plan, args.reference, args.periodEnd ?? null]
    );
  } catch (err: any) {
    throw new Error(`Could not save the subscription: ${err?.message ?? err}`);
  }
}

/** Looks up a user id from the email Paystack had on file. */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const user = await findUserByEmail(email).catch(() => null);
  return user?.id ?? null;
}

export { UnauthorizedError };