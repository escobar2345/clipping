"use client";

import React, { useEffect, useState } from "react";

/**
 * Slim header strip on the studio: who's signed in, which plan they're on,
 * how much of the monthly quota is left, plus sign out.
 *
 * Kept deliberately separate from VideoStudio so the big component doesn't grow
 * another concern, and so the same bar can be dropped into any page.
 */
export default function AccountBar() {
  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState<string>("");
  const [remaining, setRemaining] = useState<number | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    fetch("/api/billing/status")
      .then((r) => r.json())
      .then((d) => {
        setEmail(d.email ?? "");
        setPlan(d.plan?.plan ?? "free");
        setRemaining(d.remainingVideos ?? null);
      })
      .catch(() => {
        /* the bar is informational — never block the studio on it */
      })
      .finally(() => setReady(true));
  }, []);

  if (!ready) return null;

  const signedIn = Boolean(email);
  const isFree = plan === "free";

  return (
    <div style={bar}>
      <span style={who}>{signedIn ? email : "Not signed in"}</span>

      {signedIn && (
        <>
          <span style={planStyle}>
            {plan}
            {remaining !== null && ` · ${remaining} left`}
          </span>
          <a href="/billing" style={{ ...action, display: "inline-block" }}>
            {isFree ? "Upgrade" : "Manage plan"}
          </a>
          <button
            style={action}
            onClick={async () => {
              await fetch("/api/auth/signout", { method: "POST" });
              window.location.href = "/login";
            }}
          >
            Sign out
          </button>
        </>
      )}
    </div>
  );
}

const ACCENT = "#FF5A1F";

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "10px 20px",
  background: "#15171A",
  borderBottom: "1px solid #2A2D31",
  fontSize: 13,
};

const who: React.CSSProperties = { color: "#E8E6E1", fontWeight: 600 };
const planStyle: React.CSSProperties = { color: "#8A8D93", textTransform: "capitalize" };

const action: React.CSSProperties = {
  background: "transparent",
  color: ACCENT,
  border: "none",
  cursor: "pointer",
  fontSize: 13,
  textDecoration: "none",
  padding: 0,
  fontFamily: "inherit",
};