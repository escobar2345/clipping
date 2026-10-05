/**
 * Paystack client — SERVER-SIDE ONLY. Never expose the secret key to the
 * browser; only `authorization_url` (Paystack's hosted checkout page) is ever
 * sent to the client.
 *
 * Docs: https://paystack.com/docs/payments/accept-payments/
 * Test keys: sk_test_… / pk_test_… — use the same flow, no real money moves.
 */

const PAYSTACK_BASE = "https://api.paystack.co";
const TIMEOUT_MS = 30_000;

export interface PaystackPlan {
  /** Internal plan id we store in the subscriptions table. */
  id: "free" | "creator" | "pro";
  name: string;
  /** Amount in the currency's smallest unit (kobo for NGN, cents for USD). */
  amount: number;
  currency: string;
  interval: "month" | "year";
  description: string;
  features: string[];
}

/**
 * Plan catalogue. Amounts are in the currency's SMALLEST unit — Paystack
 * expects kobo for NGN (₦5,000 = 500000) and cents for USD. Set these to your
 * real prices; test keys exercise the same code path.
 */
export const PLANS: Record<PaystackPlan["id"], PaystackPlan> = {
  free: {
    id: "free",
    name: "Free",
    amount: 0,
    currency: "NGN",
    interval: "month",
    description: "Try the pipeline with watermarked exports.",
    features: [
      "3 videos analysed per month",
      "720p exports",
      "Long2Short watermark",
      "1 Buffer channel",
    ],
  },
  creator: {
    id: "creator",
    name: "Creator",
    amount: 500000, // ₦5,000
    currency: "NGN",
    interval: "month",
    description: "For creators publishing every week.",
    features: [
      "30 videos analysed per month",
      "1080p exports, no watermark",
      "Unlimited Buffer accounts & channels",
      "Priority render queue",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    amount: 1500000, // ₦15,000
    currency: "NGN",
    interval: "month",
    description: "For teams and agencies posting at volume.",
    features: [
      "Unlimited videos",
      "4K exports, no watermark",
      "Unlimited Buffer accounts & channels",
      "Caption coach + trending research",
      "Priority support",
    ],
  },
};

/** Monthly usage cap per plan. `null` means unlimited. */
export const PLAN_VIDEO_LIMITS: Record<PaystackPlan["id"], number | null> = {
  free: 3,
  creator: 30,
  pro: null,
};

/** Pays the price of a plan — the user must always come from our own table. */
export function getPlan(id: string): PaystackPlan {
  return PLANS[id as PaystackPlan["id"]] ?? PLANS.free;
}

function secretKey(): string {
  const key = (process.env.PAYSTACK_SECRET_KEY ?? "").trim();
  if (!key || key.startsWith("your_")) {
    throw new Error(
      "PAYSTACK_SECRET_KEY is not set. Add your sk_test_… key to .env.local " +
        "(dashboard.paystack.com → Settings → API Keys) and restart the dev server."
    );
  }
  return key;
}

async function paystackFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secretKey()}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body: any = await res.json().catch(() => null);
  if (!res.ok || body?.status === false) {
    throw new Error(
      body?.message ? `Paystack: ${body.message}` : `Paystack request failed (HTTP ${res.status}).`
    );
  }
  return body?.data as T;
}

export interface InitializeArgs {
  email: string;
  /** Must be a valid user id or an email Paystack already knows. */
  reference: string;
  amount: number;
  currency: string;
  callbackUrl: string;
  metadata?: Record<string, unknown>;
  planCode?: string;
}

export interface InitializeResult {
  authorization_url: string;
  access_code: string;
  reference: string;
}

/** Creates a transaction and returns Paystack's hosted checkout URL. */
export async function initializeTransaction(
  args: InitializeArgs
): Promise<InitializeResult> {
  return paystackFetch<InitializeResult>("/transaction/initialize", {
    method: "POST",
    body: JSON.stringify({
      email: args.email,
      reference: args.reference,
      // kobo/cents, and Paystack wants an integer
      amount: Math.round(args.amount),
      currency: args.currency,
      callback_url: args.callbackUrl,
      metadata: args.metadata ?? {},
      channels: undefined, // let Paystack show every channel it supports
      plan_code: args.planCode,
    }),
  });
}

export interface VerifiedTransaction {
  id: number;
  reference: string;
  status: "success" | "failed" | "abandoned" | "pending";
  amount: number;
  currency: string;
  email: string;
  paid_at?: string | null;
  metadata?: Record<string, any> | null;
}

/**
 * Re-fetches a transaction from Paystack to confirm it actually succeeded.
 *
 * This is the ONLY trustworthy way to confirm a Paystack payment — there is no
 * webhook signature to verify, so we never trust the browser's redirect. Always
 * check `status === "success"` AND that the amount matches what we expected.
 */
export async function verifyTransaction(reference: string): Promise<VerifiedTransaction | null> {
  try {
    return await paystackFetch<VerifiedTransaction>(
      `/transaction/verify/${encodeURIComponent(reference)}`
    );
  } catch {
    return null;
  }
}