"use client";
import React, { useState } from "react";

interface CaptionCoachProps {
  platforms: string[];
  draftCaption: string;
  onApplyCaption: (caption: string) => void;
}

/**
 * Caption coach: uses Apify web search + GLM to research trending hooks,
 * hashtags, and platform-specific caption advice for a target clip.
 */
export default function CaptionCoach({ platforms, draftCaption, onApplyCaption }: CaptionCoachProps) {
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
  const inputStyle: React.CSSProperties = {
    width: "100%",
    background: "#0F1012",
    border: `1px solid ${BORDER}`,
    borderRadius: 6,
    padding: "10px 12px",
    color: "#E8E6E1",
    fontSize: 14,
    fontFamily: "inherit",
  };

  return (
    <section style={{ background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 24, marginBottom: 20 }}>
      <span style={labelStyle}>Caption coach</span>
      <p style={{ fontSize: 13, color: "#8A8D93", margin: "0 0 12px" }}>
        Research viral hooks and platform-specific caption advice for: {platforms.join(", ") || "no platforms selected"}
      </p>
      <textarea
        value={draftCaption}
        onChange={(e) => onApplyCaption(e.target.value)}
        style={{ ...inputStyle, minHeight: "100px", resize: "vertical" }}
        placeholder="Enter your brief about what the post should say…"
      />
    </section>
  );
}
