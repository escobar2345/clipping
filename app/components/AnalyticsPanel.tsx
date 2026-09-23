"use client";
import React from "react";
import type { PublicAccount } from "../../lib/clientTypes";

interface AnalyticsPanelProps {
  accounts: PublicAccount[];
}

/**
 * Analytics & growth advice panel: pulls recent sent posts + engagement
 * numbers from Buffer and asks GLM for per-channel improvement advice.
 */
export default function AnalyticsPanel({ accounts }: AnalyticsPanelProps) {
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
      <span style={labelStyle}>Analytics & growth advice</span>
      {accounts.length === 0 ? (
        <p style={{ fontSize: 13, color: "#8A8D93", margin: 0 }}>
          Add a Buffer account above to see engagement analytics and AI growth advice.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {accounts.map((acc) => (
            <div key={acc.id} style={{ fontSize: 13, color: "#E8E6E1" }}>
              {acc.name}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
