"use client";

import React, { useState } from "react";

/**
 * Account creation against the app's own Postgres accounts
 * (POST /api/auth/signup → creates `users`, signs the user in immediately —
 * there is no email-confirmation step in this setup).
 */
export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !password) {
      setError("Enter an email and a password.");
      return;
    }
    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password, name: name.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Could not create the account.");

      window.location.href = "/";
    } catch (err: any) {
      setError(err?.message ?? "Could not create the account.");
      setBusy(false);
    }
  }

  return (
    <main style={wrap}>
      <form style={card} onSubmit={handleSubmit}>
        <h1 style={h1}>Create your account</h1>
        <p style={{ ...muted, margin: "0 0 22px" }}>
          Start on the free plan. Upgrade whenever you need more.
        </p>

        <label style={label} htmlFor="name">
          Name
        </label>
        <input
          id="name"
          style={input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ada Lovelace"
        />

        <label style={label} htmlFor="email">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          style={input}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
        />

        <label style={label} htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete="new-password"
          style={input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
        />

        {error && <p style={errorStyle}>{error}</p>}

        <button type="submit" style={button} disabled={busy}>
          {busy ? "Creating…" : "Create account"}
        </button>

        <p style={footNote}>
          Already have an account?{" "}
          <a href="/login" style={{ color: ACCENT }}>
            Sign in
          </a>
        </p>
      </form>
    </main>
  );
}


const ACCENT = "#FF5A1F";

const wrap: React.CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#0B0C0E",
  padding: 20,
};

const card: React.CSSProperties = {
  width: "100%",
  maxWidth: 380,
  background: "#15171A",
  border: "1px solid #2A2D31",
  borderRadius: 12,
  padding: 28,
};

const h1: React.CSSProperties = { margin: "0 0 4px", fontSize: 24, color: "#E8E6E1" };

const muted: React.CSSProperties = { margin: 0, fontSize: 14, color: "#8A8D93", lineHeight: 1.6 };

const label: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "#8A8D93",
  marginBottom: 6,
  marginTop: 14,
};

const input: React.CSSProperties = {
  width: "100%",
  background: "#0F1012",
  border: "1px solid #2A2D31",
  borderRadius: 6,
  padding: "11px 12px",
  color: "#E8E6E1",
  fontSize: 14,
  boxSizing: "border-box",
};

const button: React.CSSProperties = {
  width: "100%",
  marginTop: 20,
  background: ACCENT,
  color: "#0B0C0E",
  border: "none",
  borderRadius: 6,
  padding: "12px 18px",
  fontWeight: 700,
  fontSize: 14,
  cursor: "pointer",
};

const ghostButton: React.CSSProperties = {
  ...button,
  background: "transparent",
  color: "#E8E6E1",
  border: "1px solid #2A2D31",
};

const linkBtn: React.CSSProperties = {
  display: "block",
  textAlign: "center",
  background: ACCENT,
  color: "#0B0C0E",
  borderRadius: 6,
  padding: "12px 18px",
  fontWeight: 700,
  fontSize: 14,
  textDecoration: "none",
};

const divider: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, margin: "18px 0 0" };

const dividerText: React.CSSProperties = { fontSize: 12, color: "#8A8D93" };

const footNote: React.CSSProperties = { margin: "18px 0 0", fontSize: 13, color: "#8A8D93", textAlign: "center" };

const errorStyle: React.CSSProperties = { margin: "14px 0 0", fontSize: 13, color: "#FF9B7A" };
