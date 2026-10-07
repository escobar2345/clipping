import { NextResponse } from "next/server";
import { requireAuth } from "./authContext";
import { runAsUser } from "./userPaths";
import { isPaid, getSubscription, remainingVideoQuota } from "./billing";
import { rememberPublicOrigin } from "./tunnel";

/**
 * Wraps an API route handler with everything a request needs:
 *   1. a valid session (401 JSON when signed out)
 *   2. a user scope, so per-user storage resolves to that user's directories
 *   3. optional plan gating (402 when the plan doesn't allow the action)
 *   4. JSON errors — never an HTML page
 *
 * Usage:
 *   export const POST = withAuth(async (req) => { ... });
 *   export const POST = withAuth(async (req) => {...}, { plan: "paid" });
 *   export const POST = withAuth(async (req) => {...}, { metered: "analyze" });
 */

type Handler<Ctx> = (req: Request, ctx: { userId: string; email: string }) => Promise<Response>;

export interface WithAuthOptions {
  /** Require a paid plan (anything above `free`). */
  plan?: "paid";
  /** Count this action against a monthly quota; "analyze" = one video analysed. */
  metered?: "analyze";
}

export function withAuth<Ctx = unknown>(
  handler: Handler<Ctx>,
  options: WithAuthOptions = {}
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      // Learn the public origin this deployment is reachable at (Railway's
      // domain etc.) from the request's own Host — used for Paystack callbacks
      // and Buffer fetch URLs without needing NEXT_PUBLIC_BASE_URL set.
      rememberPublicOrigin(req.url);

      const auth = await requireAuth();

      if (options.plan === "paid") {
        const sub = await getSubscription();
        if (!isPaid(sub)) {
          return NextResponse.json(
            { error: "This feature needs a paid plan. Upgrade to continue." },
            { status: 402 }
          );
        }
      }

      if (options.metered) {
        const sub = await getSubscription();
        const remaining = await remainingVideoQuota(sub);
        if (remaining <= 0) {
          return NextResponse.json(
            {
              error:
                `You've used all the videos included in your plan this month. ` +
                `Upgrade for more, or wait for the monthly reset.`,
            },
            { status: 402 }
          );
        }
      }

      // Everything the handler touches resolves to this user's directories.
      return await runAsUser(auth.userId, () => handler(req, auth));
    } catch (err: any) {
      const status = err?.status ?? 500;
      if (status === 401) {
        return NextResponse.json(
          { error: "You must be signed in to use this endpoint." },
          { status: 401 }
        );
      }
      return NextResponse.json({ error: err?.message ?? "Request failed." }, { status });
    }
  };
}

/**
 * Same, for GET routes that need to catch their own errors. Kept separate so the
 * plain `withAuth` signature stays easy to read.
 */
export function withAuthGet(
  handler: (req: Request, ctx: { userId: string; email: string }) => Promise<Response>,
  options: WithAuthOptions = {}
) {
  return withAuth(handler, options);
}