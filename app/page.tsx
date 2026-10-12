"use client";

import React, { useState } from "react";
import VideoStudio from "./VideoStudio";
import VoiceStudio from "./components/VoiceStudio";

const ACCENT = "#FF5A1F";

type Tab = "video" | "voice";

const TAB_HINT: Record<Tab, string> = {
  video: "You are in Video Studio — click a button above to switch",
  voice: "You are in Voice-Over & Cloning — click a button above to go back",
};

export default function Page() {
  const [activeTab, setActiveTab] = useState<Tab>("video");

  const tabBtn = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "16px 20px",
    fontSize: 16,
    fontWeight: 800,
    cursor: "pointer",
    borderRadius: 10,
    border: active ? `2px solid ${ACCENT}` : "2px solid #2A2D31",
    background: active ? ACCENT : "#15171A",
    color: active ? "#0B0C0E" : "#E8E6E1",
    fontFamily: "inherit",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#0B0C0E" }}>
      {/* ==== TOP NAV BAR — always visible ==== */}
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 9999,
          background: "#000000",
          borderBottom: `3px solid ${ACCENT}`,
        }}
      >
        <div
          style={{
            maxWidth: 1000,
            margin: "0 auto",
            padding: "14px 20px",
          }}
        >
          <div
            style={{
              color: ACCENT,
              fontSize: 13,
              letterSpacing: 3,
              fontWeight: 800,
              marginBottom: 10,
              textAlign: "center",
            }}
          >
            LONG2SHORT
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              type="button"
              data-testid="tab-video"
              style={tabBtn(activeTab === "video")}
              onClick={() => {
                setActiveTab("video");
                window.scrollTo({ top: 0 });
              }}
            >
              🎬 Video Studio
            </button>
            <button
              type="button"
              data-testid="tab-voice"
              style={tabBtn(activeTab === "voice")}
              onClick={() => {
                setActiveTab("voice");
                window.scrollTo({ top: 0 });
              }}
            >
              🎙️ Voice-Over &amp; Cloning
            </button>
            <a
              href="/filmcraft/index.html?webgl"
              data-testid="tab-editing"
              title="Open FilmCraft — the original Premiere-style editor (WebGL2 backend for compatibility)"
              style={{
                ...tabBtn(false),
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                textDecoration: "none",
              }}
            >
              🎞️ Editing Studio
            </a>
          </div>
          <div
            style={{
              marginTop: 8,
              textAlign: "center",
              fontSize: 12,
              color: "#8A8D93",
            }}
          >
            {TAB_HINT[activeTab]}
          </div>
        </div>
      </header>

      {activeTab === "video" ? <VideoStudio /> : <VoiceStudio />}
    </div>
  );
}
