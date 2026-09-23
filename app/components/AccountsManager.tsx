"use client";
import React from "react";
import type { AccountChannels } from "../../lib/clientTypes";

interface AccountsManagerProps {
  accounts: AccountChannels[];
  onChanged: () => void | Promise<void>;
}

/**
 * Buffer accounts panel: lists saved accounts + their channels.
 * In the full app this panel also lets you add/remove accounts via
 * /api/accounts and add/edit channel selections.
 */
export default function AccountsManager({ accounts, onChanged }: AccountsManagerProps) {
  const ACCENT = "#FF5A1F";
  const BORDER = "#2A2D31";
  const PANEL = "#15171A";
  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    letterSpacing: 1.5,
    textTransform: "uppercase",
    color: "#8A8D93",
    marginBottom: 8,
    display: "block",
  };

  return (
    <section style={{ background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 24, marginBottom: 20 }}>
      <span style={labelStyle}>Buffer accounts</span>
      {accounts.length === 0 ? (
        <p style={{ fontSize: 13, color: "#8A8D93", margin: "0 0 10px" }}>
          No Buffer accounts saved. Add one with a personal API key from buffer.com → Settings → API.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {accounts.map((acc) => (
            <div key={acc.account.id}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{acc.account.name}</div>
              {acc.error && <span style={{ color: ACCENT, fontSize: 12 }}>{acc.error}</span>}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {acc.channels.map((ch) => (
                  <span key={ch.id} style={{ fontSize: 12, color: "#E8E6E1" }}>
                    {ch.displayName} ({ch.service})
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
