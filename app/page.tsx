"use client";

import React, { useState } from "react";
import VideoStudio from "./VideoStudio";
import VoiceStudio from "./components/VoiceStudio";

const ACCENT = "#FF5A1F";
const BORDER = "#2A2D31";

type Tab = "video" | "voice";

const tabStyle = (active: boolean): React.CSSProperties => ({
  flex: 1,
  textAlign: "center",
  padding: "14px 16px",
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: 0.5,
  cursor: "pointer",
  userSelect: "none",
  border: "none",
  borderBottom: `2px solid ${active ? ACCENT : "transparent"}`,
  background: active ? "#1A1C1F" : "transparent",
  color: active ? ACCENT : "#8A8D93",
  fontFamily: "inherit",
});

export default function Page() {
  const [activeTab, setActiveTab] = useState<Tab>("video");

  return (
    <>
      <nav
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "#0B0C0E",
          borderBottom: `1px solid ${BORDER}`,
          boxShadow: "0 2px 12px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            maxWidth: 760,
            margin: "0 auto",
            padding: "0 20px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div
            style={{
              color: ACCENT,
              fontSize: 12,
              letterSpacing: 2,
              fontWeight: 800,
              whiteSpace: "nowrap",
              marginRight: 12,
            }}
          >
            LONG2SHORT
          </div>
          <div style={{ display: "flex", flex: 1 }}>
            <button
              style={tabStyle(activeTab === "video")}
              onClick={() => setActiveTab("video")}
              title="Upload videos, prompt the AI to edit them into short clips, and post to Buffer/Twitter"
            >
              🎬 Video Studio
            </button>
            <button
              style={tabStyle(activeTab === "voice")}
              onClick={() => setActiveTab("voice")}
              title="Voice over + voice cloning with the Chatterbox TTS engine"
            >
              🎙️ Voice Studio
            </button>
          </div>
        </div>
      </nav>

      {activeTab === "video" ? <VideoStudio /> : <VoiceStudio />}
    </>
  );
}