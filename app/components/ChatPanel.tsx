"use client";
import React, { useState } from "react";

/**
 * Floating chat assistant: a side panel that lets you ask questions about
 * the current edit plan, caption drafts, or clip strategy. Propose-only
 * until you confirm — it never executes actions on its own.
 */
export default function ChatPanel() {
  const ACCENT = "#FF5A1F";
  const BORDER = "#2A2D31";
  const PANEL = "#15171A";
  const [messages, setMessages] = useState<string[]>([]);
  const [input, setInput] = useState("");

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages((prev) => [...prev, input]);
    setInput("");
  };

  return (
    <section style={{ background: PANEL, border: `1px solid ${BORDER}`, borderRadius: 10, padding: 24, marginBottom: 20 }}>
      <div style={{ fontSize: 12, letterSpacing: 1.5, textTransform: "uppercase", color: "#8A8D93", marginBottom: 12 }}>
        AI assistant
      </div>
      <div style={{ minHeight: "80px", display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        {messages.map((msg, i) => (
          <div key={i} style={{ fontSize: 13, color: "#E8E6E1", padding: "8px 12px", background: "#0F1012", borderRadius: 6 }}>
            {msg}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the current clip plan, captions, etc.…"
          style={{
            flex: 1,
            background: "#0F1012",
            border: `1px solid ${BORDER}`,
            borderRadius: 6,
            padding: "10px 12px",
            color: "#E8E6E1",
            fontSize: 14,
            fontFamily: "inherit",
          }}
        />
        <button
          onClick={handleSend}
          style={{
            background: ACCENT,
            color: "#0B0C0E",
            border: "none",
            borderRadius: 6,
            padding: "10px 18px",
            fontWeight: 700,
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          Send
        </button>
      </div>
    </section>
  );
}
