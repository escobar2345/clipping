"use client";

import React, { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Pricing + checkout. Reads the current plan from /api/billing/status, then
 * sends the user to Paystack's hosted page for the plan they picked.
 *
 * Paystack redirects back to /billing?reference=… — on return we POST that
 * reference to /api/billing/status, which re-verifies the transaction with
 * Paystack (never trusts the query string) and upgrades the account.
 */
interface Plan {
  id: "free" | "creator" | "pro";
  name: string;
  amount: number;
  currency: string;
  interval: string;
  description: string;
  features: string[];
}

/** Amounts come from Paystack in the currency's smallest unit (kobo/cents). */
function money(amount: number, currency: string): string {
  const major = amount / 100;
  const symbol = currency === "NGN" ? "₦" : currency === "USD" ? "$" : `${currency} `;
  return `${symbol}${major.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export default function BillingPage() {
  return (
    <Suspense>
      <BillingInner />
    </Suspense>
  );
}

/**
 * Inner pricing/checkout component. Split out because useSearchParams() needs
 * a Suspense boundary above it — without one, `next build` fails on /billing.
 */
function BillingInner() {
  const router = useRouter();
  const params = useSearchParams();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [current, setCurrent] = useState<string>("free");
  const [remaining, setRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const confirmPayment = useCallback(
    async (reference: string) => {
      setNotice({ kind: "ok", text: "Confirming your payment…" });
      try {
        const res = await fetch("/api/billing/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reference }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Payment could not be confirmed.");
        setNotice({ kind: "ok", text: "Payment received — your plan is active." });
        router.push("/");
      } catch (err: any) {
        setNotice({ kind: "err", text: err?.message ?? "Payment could not be confirmed." });
      }
    },
    [router]
  );

  useEffect(() => {
    // Returning from Paystack with a reference means a payment just happened.
    const reference = params.get("reference");
    if (reference) {
      confirmPayment(reference);
      return;
    }
    fetch("/api/billing/status")
      .then((r) => r.json())
      .then((d) => {
        if (Array.isArray(d.plans)) setPlans(d.plans);
        setCurrent(d.plan?.plan ?? "free");
        setRemaining(d.remainingVideos ?? null);
      })
      .catch(() => setNotice({ kind: "err", text: "Could not load your plan." }));
  }, [params, confirmPayment]);

  async function choose(plan: Plan) {
    if (plan.id === "free") return;
    setBusy(plan.id);
    setNotice(null);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: plan.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start checkout.");
      // Hand off to Paystack's hosted checkout.
      window.location.href = data.authorizationUrl;
    } catch (err: any) {
      setNotice({ kind: "err", text: err?.message ?? "Could not start checkout." });
      setBusy(null);
    }
  }

  return (
    <main style={wrap}>
      <div style={head}>
        <h1 style={h1}>Plans</h1>
        <p style={muted}>
          You&apos;re on <strong style={{ color: ACCENT }}>{current}</strong>
          {remaining === null ? " — unlimited videos." : ` — ${remaining} left this month.`}
        </p>
      </div>

      {notice && <p style={notice.kind === "ok" ? okStyle : errStyle}>{notice.text}</p>}

      <div style={grid}>
        {plans.map((plan) => {
          const active = plan.id === current;
          return (
            <div key={plan.id} style={{ ...card, borderColor: active ? ACCENT : BORDER }}>
              <h2 style={planName}>{plan.name}</h2>
              <p style={price}>
                {plan.amount === 0 ? "Free" : money(plan.amount, plan.currency)}
                {plan.amount > 0 && <span style={per}>/{plan.interval}</span>}
              </p>
              <p style={{ ...muted, minHeight: 38 }}>{plan.description}</p>
              <ul style={features}>
                {plan.features.map((f) => (
                  <li key={f}>✓ {f}</li>
                ))}
              </ul>
              <button
                style={{ ...button, ...(active ? ghost : primary) }}
                disabled={active || busy !== null}
                onClick={() => choose(plan)}
              >
                {active ? "Current plan" : busy === plan.id ? "Redirecting…" : `Choose ${plan.name}`}
              </button>
            </div>
          );
        })}
      </div>

      <div style={foot}>
        <button
          style={signout}
          onClick={async () => {
            await fetch("/api/auth/signout", { method: "POST" });
            router.push("/login");
            router.refresh();
          }}
        >
          Sign out
        </button>
        <button style={link} onClick={() => router.push("/")}>
          ← Back to the studio
        </button>
      </div>
    </main>
  );
}
const ACCENT = "#FF5A1F";
const BORDER = "#2A2D31";

const wrap: React.CSSProperties = { minHeight: "100vh", background: "#0B0C0E", padding: "40px 20px" };
const head: React.CSSProperties = { textAlign: "center", marginBottom: 28 };
const h1: React.CSSProperties = { margin: 0, fontSize: 28, color: "#E8E6E1" };
const muted: React.CSSProperties = { margin: "8px 0 0", fontSize: 14, color: "#8A8D93" };

const grid: React.CSSProperties = {
  display: "grid",
  gap: 18,
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  maxWidth: 1000,
  margin: "0 auto",
};

const card: React.CSSProperties = {
  background: "#15171A",
  border: `1px solid ${BORDER}`,
  borderRadius: 12,
  padding: 24,
  display: "flex",
  flexDirection: "column",
};

const planName: React.CSSProperties = { margin: 0, fontSize: 18, color: "#E8E6E1" };
const price: React.CSSProperties = { margin: "6px 0 0", fontSize: 30, color: ACCENT, fontWeight: 700 };
const per: React.CSSProperties = { fontSize: 14, color: "#8A8D93", fontWeight: 400 };
const features: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: "14px 0 20px",
  fontSize: 13,
  color: "#C9CBD0",
  lineHeight: 2,
  flex: 1,
};

const button: React.CSSProperties = {
  width: "100%",
  borderRadius: 6,
  padding: "12px 18px",
  fontWeight: 700,
  fontSize: 14,
  cursor: "pointer",
};
const primary: React.CSSProperties = { background: ACCENT, color: "#0B0C0E", border: "none" };
const ghost: React.CSSProperties = {
  background: "transparent",
  color: "#8A8D93",
  border: `1px solid ${BORDER}`,
  cursor: "not-allowed",
};

const okStyle: React.CSSProperties = { textAlign: "center", color: "#9FD8A0", fontSize: 14 };
const errStyle: React.CSSProperties = { textAlign: "center", color: "#FF9B7A", fontSize: 14 };

const foot: React.CSSProperties = { display: "flex", gap: 18, justifyContent: "center", marginTop: 32 };
const signout: React.CSSProperties = {
  background: "transparent",
  color: "#8A8D93",
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  padding: "8px 16px",
  cursor: "pointer",
};
const link: React.CSSProperties = {
  background: "transparent",
  color: ACCENT,
  border: "none",
  cursor: "pointer",
  fontSize: 14,
};