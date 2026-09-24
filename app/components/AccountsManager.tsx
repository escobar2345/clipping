"use client";
import React, { useState } from "react";
import type { AccountChannels, PublicAccount } from "../../lib/clientTypes";

interface AccountsManagerProps {
  accounts: AccountChannels[];
  savedAccounts: PublicAccount[];
  onChanged: () => void | Promise<void>;
}

// Design tokens — same set page.tsx / other panels use.
const ACCENT = "#FF5A1F";
const PANEL = "#15171A";
const BORDER = "#2A2D31";

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "#8A8D93",
  marginBottom: 8,
  display: "block",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "#0F1012",
  border: `1px solid ${BORDER}`,
  borderRadius: 6,
  padding: "10px 12px",
  color: "#E8E6E1",
  fontSize: 14,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

const fieldLabel: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "#8A8D93",
  marginBottom: 6,
  display: "block",
};

const buttonStyle: React.CSSProperties = {
  background: ACCENT,
  color: "#0B0C0E",
  border: "none",
  borderRadius: 6,
  padding: "10px 18px",
  fontWeight: 700,
  fontSize: 14,
  cursor: "pointer",
  fontFamily: "inherit",
};

const buttonDisabled: React.CSSProperties = {
  ...buttonStyle,
  background: "#3A3D42",
  color: "#8A8D93",
  cursor: "not-allowed",
};

const dangerButton: React.CSSProperties = {
  ...buttonStyle,
  background: "#8C2E1F",
  color: "#FFE1D6",
  padding: "6px 12px",
  fontSize: 12,
};

/**
 * Buffer accounts panel: add a personal API key (validated live against
 * Buffer, stored server-side in data/accounts.json — the token never comes
 * back to the browser), see each account's channels, remove accounts.
 */
export default function AccountsManager({ accounts, savedAccounts, onChanged }: AccountsManagerProps) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [orgId, setOrgId] = useState("");
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormSuccess(null);
    if (!name.trim() || !token.trim()) {
      setFormError("Display name and API key are both required.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          accessToken: token.trim(),
          organizationId: orgId.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error ?? `Could not save the account (HTTP ${res.status}).`);
        return;
      }
      const addedName: string = data.account?.name ?? name.trim();
      setName("");
      setToken("");
      setOrgId("");
      setFormSuccess(`Added "${addedName}" - its channels are now selectable per clip.`);
      await onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Network error — is the server running?");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(id: string) {
    setFormError(null);
    setFormSuccess(null);
    setRemovingId(id);
    try {
      const res = await fetch("/api/accounts", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFormError(data.error ?? `Could not remove the account (HTTP ${res.status}).`);
        return;
      }
      await onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Network error — is the server running?");
    } finally {
      setRemovingId(null);
    }
  }

  // Channels/errors come from /api/buffer/channels, keyed by the same
  // account ids as savedAccounts (from /api/accounts).
  const channelEntries = new Map(accounts.map((a) => [a.account.id, a]));

  return (
    <section style={{ background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 24, marginBottom: 20 }}>
      <span style={labelStyle}>Buffer accounts</span>
      {savedAccounts.length === 0 ? (
        <p style={{ fontSize: 13, color: "#8A8D93", margin: "0 0 10px" }}>
          No Buffer accounts saved. Add one with a personal API key from buffer.com → Settings → API.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
          {savedAccounts.map((acc) => {
            const entry = channelEntries.get(acc.id);
            const isEnv = acc.id === "env-default";
            return (
              <div
                key={acc.id}
                style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: "12px 14px", background: "#0F1012" }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    marginBottom: 4,
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 14, color: "#E8E6E1" }}>
                    {acc.name}
                    {isEnv && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: "#FFD37A", fontWeight: 400 }}>
                        from BUFFER_ACCESS_TOKEN
                      </span>
                    )}
                    {!isEnv && acc.organizationId && (
                      <span style={{ marginLeft: 8, fontSize: 11, color: "#8A8D93", fontWeight: 400 }}>
                        org {acc.organizationId}
                      </span>
                    )}
                  </div>
                  {!isEnv && (
                    <button
                      type="button"
                      style={dangerButton}
                      disabled={removingId === acc.id}
                      onClick={() => handleRemove(acc.id)}
                    >
                      {removingId === acc.id ? "Removing…" : "Remove"}
                    </button>
                  )}
                </div>
                {entry?.error ? (
                  <span style={{ color: ACCENT, fontSize: 12 }}>{entry.error}</span>
                ) : entry && entry.channels.length > 0 ? (
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {entry.channels.map((ch) => (
                      <span
                        key={ch.id}
                        style={{
                          fontSize: 12,
                          color: "#E8E6E1",
                          border: `1px solid ${BORDER}`,
                          borderRadius: 999,
                          padding: "3px 10px",
                        }}
                      >
                        {ch.displayName} ({ch.service})
                      </span>
                    ))}
                  </div>
                ) : (
                  <span style={{ fontSize: 12, color: "#8A8D93" }}>
                    {entry ? "No channels connected in this Buffer organization." : "Loading channels…"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {formError && <p style={{ fontSize: 13, color: ACCENT, margin: "0 0 10px" }}>{formError}</p>}
      {formSuccess && <p style={{ fontSize: 13, color: "#9FD9A8", margin: "0 0 10px" }}>{formSuccess}</p>}

      {!showForm ? (
        <button
          type="button"
          style={buttonStyle}
          onClick={() => {
            setShowForm(true);
            setFormError(null);
            setFormSuccess(null);
          }}
        >
          + Add Buffer account
        </button>
      ) : (
        <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
            <div>
              <label style={fieldLabel} htmlFor="buffer-acc-name">
                Display name
              </label>
              <input
                id="buffer-acc-name"
                style={inputStyle}
                placeholder="e.g. Main account"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div>
              <label style={fieldLabel} htmlFor="buffer-acc-token">
                Personal API key
              </label>
              <input
                id="buffer-acc-token"
                style={inputStyle}
                type="password"
                placeholder="from buffer.com → Settings → API"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoComplete="off"
              />
            </div>
            <div>
              <label style={fieldLabel} htmlFor="buffer-acc-org">
                Organization ID (optional — auto-detected)
              </label>
              <input
                id="buffer-acc-org"
                style={inputStyle}
                placeholder="only if one key reaches multiple orgs"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button type="submit" style={busy ? buttonDisabled : buttonStyle} disabled={busy}>
              {busy ? "Validating with Buffer…" : "Save account"}
            </button>
            <button
              type="button"
              style={{ ...dangerButton, background: "transparent", color: "#8A8D93", border: `1px solid ${BORDER}` }}
              onClick={() => {
                setShowForm(false);
                setFormError(null);
                setFormSuccess(null);
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
          <p style={{ fontSize: 12, color: "#8A8D93", margin: 0 }}>
            The key is validated live against Buffer, then stored server-side in <code>data/accounts.json</code> — it
            is never sent back to the browser.
          </p>
        </form>
      )}
    </section>
  );
}
