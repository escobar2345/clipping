"use client";

import React, { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "../../lib/supabase/client";

/**
 * Email + password sign-in, plus Google OAuth.
 *
 * Supabase decides whether an email must be confirmed first — when it is, the
 * callback route handles the emailed link. The message below tells the user
 * which of the two happened rather than pretending sign-in always succeeded.
 *
 * Wrapped in Suspense because useSearchParams() needs a boundary above it —
 * without one, `next build` fails on /login.
 */
export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const params = useSearchParams();
  // Redirects here carry ?error=… (e.g. middleware when Supabase keys are
  // missing, or the OAuth callback when the exchange fails). Surface it as a
  // banner so the user sees WHY they landed on the login page.
  const urlError = params.get("error");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (urlError) setError(decodeURIComponent(urlError));
  }, [urlError]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }

    setBusy(true);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (err) throw err;

      // A full reload lets middleware pick up the new session cookie.
      window.location.href = "/";
    } catch (err: any) {
      setError(err?.message ?? "Could not sign in.");
      setBusy(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      });
      if (err) throw err;
      // Supabase redirects the browser itself.
    } catch (err: any) {
      setError(err?.message ?? "Could not start Google sign-in.");
      setBusy(false);
    }
  }

  return (
    <main style={wrap}>
      <form style={card} onSubmit={handleSubmit}>
        <h1 style={{ margin: "0 0 4px", fontSize: 24, color: "#E8E6E1" }}>Long2Short</h1>
        <p style={{ margin: "0 0 22px", fontSize: 14, color: "#8A8D93" }}>
          Sign in to turn long videos into shorts.
        </p>

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
          autoComplete="current-password"
          style={input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
        />

        {error && <p style={errorStyle}>{error}</p>}
        {info && <p style={infoStyle}>{info}</p>}

        <button type="submit" style={button} disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <div style={divider}>
          <span style={dividerText}>or</span>
        </div>

        <button type="button" style={ghostButton} onClick={handleGoogle} disabled={busy}>
          Continue with Google
        </button>

        <p style={{ margin: "18px 0 0", fontSize: 13, color: "#8A8D93", textAlign: "center" }}>
          No account?{" "}
          <a href="/signup" style={{ color: ACCENT }}>
            Create one
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

const divider: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  margin: "18px 0 0",
};

const dividerText: React.CSSProperties = { fontSize: 12, color: "#8A8D93" };

const errorStyle: React.CSSProperties = {
  margin: "14px 0 0",
  fontSize: 13,
  color: "#FF9B7A",
};

const infoStyle: React.CSSProperties = {
  margin: "14px 0 0",
  fontSize: 13,
  color: "#9FD8A0",
};