import { createClient } from "./supabase/server";
import { createAdminClient } from "./supabase/admin";
import { PLANS, PLAN_VIDEO_LIMITS, type PaystackPlan } from "./paystack";
import { getAuthContext, UnauthorizedError } from "./authContext";

/**
 * Subscriptions live in Supabase Postgres so they survive a redeploy and are
 * shared across every instance of the app (unlike the per-user files on disk,
 * which are local to one machine).
 *
 * Table: `subscriptions` (see supabase/schema.sql)
 *   user_id       uuid primary key, references auth.users
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
 * falls back to the free plan rather than erroring — so a Supabase hiccup
 * degrades to "free tier", never to a broken app.
 */
export async function getSubscription(): Promise<Subscription | null> {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const supabase = createClient();
  const { data, error } = await supabase
    .from("subscriptions")
    .select("plan, status, current_period_end")
    .eq("user_id", ctx.userId)
    .maybeSingle();

  // A genuinely missing row is the free tier. A database/schema/query error
  // is not: treating it as free hides failed payment writes and produces a
  // misleading monthly-quota message for paid users.
  if (error) throw new Error(`Could not load your subscription: ${error.message}`);
  if (!data) return { ...FREE_SUBSCRIPTION };
  return {
    plan: (PLANS[data.plan as PaystackPlan["id"]] ? data.plan : "free") as PaystackPlan["id"],
    status: data.status ?? "active",
    currentPeriodEnd: data.current_period_end ?? null,
  };
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
  const limit = PLAN_VIDEO_LIMITS[(sub?.plan ?? "free") as PaystackPlan["id"]] ?? 0;
  if (limit === null) return Infinity;
  if (limit === 0) return limit;

  const ctx = await getAuthContext();
  if (!ctx) return 0;

  try {
    const supabase = createClient();
    const since = new Date();
    since.setUTCDate(1); // start of the current calendar month
    since.setUTCHours(0, 0, 0, 0);

    const { count, error } = await supabase
      .from("usage_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", ctx.userId)
      .eq("kind", "analyze")
      .gte("created_at", since.toISOString());

    if (error || typeof count !== "number") return limit;
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
    const supabase = createClient();
    await supabase.from("usage_events").insert({ user_id: ctx.userId, kind: "analyze" });
  } catch {
    // Usage tracking must never block the actual work.
  }
}

/**
 * Records a confirmed Paystack payment. Called from the webhook (no user
 * session) so it uses the service-role client and bypasses RLS.
 */
export async function recordPayment(args: {
  userId: string;
  plan: string;
  reference: string;
  periodEnd?: string | null;
}): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from("subscriptions").upsert(
    {
      user_id: args.userId,
      plan: args.plan,
      status: "active",
      paystack_ref: args.reference,
      current_period_end: args.periodEnd ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) throw new Error(`Could not save the subscription: ${error.message}`);
}

/** Looks up a user id from the email Paystack had on file. */
export async function findUserIdByEmail(email: string): Promise<string | null> {
  const admin = createAdminClient();
  // listUsers filters server-side; page through a little in case of collisions.
  for (let page = 1; page <= 5; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return null;
    const hit = data?.users?.find((u) => (u.email ?? "").toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (!data?.users?.length || data.users.length < 200) break;
  }
  return null;
}

export { UnauthorizedError };