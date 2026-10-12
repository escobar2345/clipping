"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  StudioMedia,
  StudioClip,
  StudioAction,
  StudioChatMsg,
  StudioTransition,
} from "../../lib/studioTypes";

const ACCENT = "#FF5A1F";
const BG = "#0B0C0E";
const PANEL = "#15171A";
const BORDER = "#2A2D31";
const TEXT = "#E8E6E1";
const MUTED = "#8A8D93";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const newId = () => `c-${Math.random().toString(36).slice(2, 9)}`;
const clipDuration = (c: StudioClip) => Math.max(0, (c.srcEnd - c.srcStart) / (c.speed || 1));
const fileUrl = (mediaId: string) => `/api/studio/file?name=uploads/${encodeURIComponent(mediaId)}`;
const fmt = (t: number) => {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
};

const panel: React.CSSProperties = {
  background: PANEL,
  border: `1px solid ${BORDER}`,
  borderRadius: 10,
  padding: 14,
};
const label: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: MUTED,
  fontWeight: 700,
  marginBottom: 8,
};
const btn = (active?: boolean): React.CSSProperties => ({
  padding: "8px 12px",
  borderRadius: 8,
  border: `1px solid ${active ? ACCENT : BORDER}`,
  background: active ? ACCENT : "#1D2024",
  color: active ? "#0B0C0E" : TEXT,
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
  fontFamily: "inherit",
});
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 8,
  border: `1px solid ${BORDER}`,
  background: "#0E1013",
  color: TEXT,
  fontSize: 13,
  fontFamily: "inherit",
  boxSizing: "border-box",
};

type ClipPlan = StudioClip;

export default function EditingStudio() {
  const [mode, setMode] = useState<"manual" | "ai">("manual");
  const [bin, setBin] = useState<StudioMedia[]>([]);
  const [clips, setClips] = useState<ClipPlan[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [messages, setMessages] = useState<StudioChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceNote, setVoiceNote] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<{ url: string; downloadUrl: string } | null>(
    null
  );

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const recRef = useRef<any>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const clipStarts = useMemo(() => {
    const starts: number[] = [];
    let acc = 0;
    for (const c of clips) {
      starts.push(acc);
      acc += clipDuration(c);
    }
    return starts;
  }, [clips]);

  const totalDur = useMemo(
    () => clips.reduce((acc, c) => acc + clipDuration(c), 0),
    [clips]
  );

  const locate = (t: number): { index: number; offset: number } => {
    if (!clips.length) return { index: -1, offset: 0 };
    for (let i = 0; i < clips.length; i++) {
      const end = clipStarts[i] + clipDuration(clips[i]);
      if (t < end - 1e-4 || i === clips.length - 1) {
        return { index: i, offset: clamp(t - clipStarts[i], 0, clipDuration(clips[i])) };
      }
    }
    return { index: -1, offset: 0 };
  };

  const active = locate(playhead);
  const activeClip = active.index >= 0 ? clips[active.index] : null;

  // Keep the playhead inside the timeline if clips are removed.
  useEffect(() => {
    setPlayhead((p) => (p > totalDur ? totalDur : p));
  }, [totalDur]);

  // Sync the preview <video> to the playhead (seek to the right source frame).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (!activeClip) {
      if (v.src) {
        v.pause();
        v.removeAttribute("src");
        v.load();
      }
      return;
    }
    const url = fileUrl(activeClip.mediaId);
    if (v.dataset.media !== url) {
      v.dataset.media = url;
      v.src = url;
    }
    const sourcePos = activeClip.srcStart + active.offset * (activeClip.speed || 1);
    if (Math.abs(v.currentTime - sourcePos) > 0.2) {
      try {
        v.currentTime = clamp(sourcePos, 0, activeClip.srcEnd);
      } catch {
        /* metadata not ready yet */
      }
    }
  }, [playhead, clips, bin]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [playing]);

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || !playing || !activeClip) return;
    if (v.currentTime >= activeClip.srcEnd - 0.03 || v.ended) {
      const next = active.index + 1;
      if (next < clips.length) setPlayhead(clipStarts[next]);
      else {
        setPlaying(false);
        setPlayhead(totalDur);
      }
      return;
    }
    const offset = (v.currentTime - activeClip.srcStart) / (activeClip.speed || 1);
    setPlayhead(clipStarts[active.index] + offset);
  };

  const computeTotal = (arr: StudioClip[]) => arr.reduce((a, c) => a + clipDuration(c), 0);

  async function onPickFiles(list: FileList | null) {
    if (!list || !list.length) return;
    setUploading(true);
    try {
      for (const file of Array.from(list)) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/studio/upload", { method: "POST", body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Upload failed");
        setBin((b) => [...b, data.media as StudioMedia]);
      }
    } catch (e: any) {
      alert(e.message ?? "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function addToTimeline(m: StudioMedia) {
    const clip: StudioClip = {
      id: newId(),
      mediaId: m.mediaId,
      srcStart: 0,
      srcEnd: m.durationSec,
      speed: 1,
      volume: 1,
      text: "",
      transition: "none",
    };
    setClips((c) => [...c, clip]);
    setSelectedId(clip.id);
  }

  function updateSelected(patch: Partial<StudioClip>) {
    if (!selectedId) return;
    setClips((cs) =>
      cs.map((c) => {
        if (c.id !== selectedId) return c;
        const next = { ...c, ...patch };
        const m = bin.find((b) => b.mediaId === next.mediaId);
        const max = m ? m.durationSec : next.srcEnd;
        next.srcStart = clamp(next.srcStart, 0, Math.max(0, max - 0.05));
        next.srcEnd = clamp(next.srcEnd, next.srcStart + 0.05, max);
        next.speed = clamp(next.speed, 0.5, 2);
        next.volume = clamp(next.volume, 0, 2);
        return next;
      })
    );
  }

  function splitAtPlayhead() {
    const { index, offset } = locate(playhead);
    if (index < 0) return;
    const srcT = clips[index].srcStart + offset * (clips[index].speed || 1);
    if (srcT <= clips[index].srcStart + 0.05 || srcT >= clips[index].srcEnd - 0.05) return;
    setClips((cs) => {
      const next = cs.map((c) => ({ ...c }));
      const right: StudioClip = { ...next[index], id: newId(), srcStart: srcT };
      next[index] = { ...next[index], srcEnd: srcT };
      next.splice(index + 1, 0, right);
      return next;
    });
  }

  function deleteSelected() {
    if (!selectedId) return;
    setClips((cs) => cs.filter((c) => c.id !== selectedId));
    setSelectedId(null);
  }

  function moveSelected(dir: -1 | 1) {
    if (!selectedId) return;
    setClips((cs) => {
      const i = cs.findIndex((c) => c.id === selectedId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= cs.length) return cs;
      const next = cs.map((c) => ({ ...c }));
      const [item] = next.splice(i, 1);
      next.splice(j, 0, item);
      return next;
    });
  }

  function clearTimeline() {
    setClips([]);
    setSelectedId(null);
  }

  // Applies a list of AI (or programmatic) actions to the timeline in order.
  function applyActions(actions: StudioAction[]): string[] {
    const logs: string[] = [];
    let next: StudioClip[] = clips.map((c) => ({ ...c }));
    let newPlayhead: number | null = null;

    for (const a of actions) {
      switch (a.op) {
        case "addMedia": {
          const m = bin.find((b) => b.mediaId === a.mediaId);
          if (!m) {
            logs.push(`addMedia: no media "${a.mediaId}"`);
            break;
          }
          const clip: StudioClip = {
            id: newId(),
            mediaId: m.mediaId,
            srcStart: 0,
            srcEnd: m.durationSec,
            speed: 1,
            volume: 1,
            text: "",
            transition: "none",
          };
          const at = typeof a.at === "number" ? clamp(a.at, 0, next.length) : next.length;
          next.splice(at, 0, clip);
          logs.push(`Added "${m.name}" to the timeline`);
          break;
        }
        case "split": {
          let acc = 0;
          let done = false;
          for (let i = 0; i < next.length; i++) {
            const d = clipDuration(next[i]);
            if (a.atSec > acc + 0.05 && a.atSec < acc + d - 0.05) {
              const srcT = next[i].srcStart + (a.atSec - acc) * (next[i].speed || 1);
              const right: StudioClip = { ...next[i], id: newId(), srcStart: srcT };
              next[i] = { ...next[i], srcEnd: srcT };
              next.splice(i + 1, 0, right);
              logs.push(`Split at ${fmt(a.atSec)}`);
              done = true;
              break;
            }
            acc += d;
          }
          if (!done) logs.push("split: no clip spans that time");
          break;
        }
        case "trim": {
          const c = next.find((x) => x.id === a.clipId);
          if (!c) {
            logs.push("trim: unknown clip");
            break;
          }
          const m = bin.find((b) => b.mediaId === c.mediaId);
          const max = m ? m.durationSec : c.srcEnd;
          if (typeof a.srcStart === "number") c.srcStart = clamp(a.srcStart, 0, max - 0.05);
          if (typeof a.srcEnd === "number") c.srcEnd = clamp(a.srcEnd, c.srcStart + 0.05, max);
          logs.push("Trimmed a clip");
          break;
        }
        case "setSpeed": {
          const c = next.find((x) => x.id === a.clipId);
          if (c) {
            c.speed = clamp(a.speed, 0.5, 2);
            logs.push(`Set speed ${c.speed}×`);
          }
          break;
        }
        case "setVolume": {
          const c = next.find((x) => x.id === a.clipId);
          if (c) {
            c.volume = clamp(a.volume, 0, 2);
            logs.push(`Set volume ${c.volume.toFixed(2)}`);
          }
          break;
        }
        case "setText": {
          const c = next.find((x) => x.id === a.clipId);
          if (c) {
            c.text = String(a.text ?? "");
            logs.push("Set overlay text");
          }
          break;
        }
        case "setTransition": {
          const c = next.find((x) => x.id === a.clipId);
          if (c) {
            c.transition = a.transition;
            logs.push(`Set transition ${a.transition}`);
          }
          break;
        }
        case "removeClip": {
          const i = next.findIndex((x) => x.id === a.clipId);
          if (i >= 0) {
            next.splice(i, 1);
            logs.push("Removed a clip");
          }
          break;
        }
        case "moveClip": {
          const i = next.findIndex((x) => x.id === a.clipId);
          if (i >= 0) {
            const [item] = next.splice(i, 1);
            next.splice(clamp(a.toIndex ?? 0, 0, next.length), 0, item);
            logs.push("Reordered clips");
          }
          break;
        }
        case "clearTimeline": {
          next = [];
          logs.push("Cleared the timeline");
          break;
        }
        case "setPlayhead": {
          newPlayhead = clamp(a.atSec, 0, computeTotal(next));
          logs.push(`Moved playhead to ${fmt(a.atSec)}`);
          break;
        }
      }
    }

    setClips(next);
    if (newPlayhead !== null) setPlayhead(newPlayhead);
    return logs;
  }

  async function sendInstruction(text: string) {
    const instruction = text.trim();
    if (!instruction || aiBusy) return;
    setMessages((m) => [...m, { role: "user", content: instruction }]);
    setInput("");
    setAiBusy(true);
    try {
      const res = await fetch("/api/studio/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instruction,
          history: messages.slice(-8),
          context: {
            media: bin,
            timeline: { clips, fps: 30 },
            playhead,
            selectedClipId: selectedId,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "AI request failed");
      const logs = applyActions(data.actions || []);
      const summary = (data.reply || "Done.") + (logs.length ? `\n• ${logs.join("\n• ")}` : "");
      setMessages((m) => [...m, { role: "assistant", content: summary }]);
    } catch (e: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `⚠️ ${e.message ?? "Failed to reach the AI."}` },
      ]);
    } finally {
      setAiBusy(false);
    }
  }

  function toggleVoice() {
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) {
      setVoiceNote("Voice input isn't supported in this browser — try Chrome/Edge, or type instead.");
      return;
    }
    if (listening && recRef.current) {
      recRef.current.stop();
      return;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.interimResults = false;
    rec.continuous = false;
    rec.onstart = () => {
      setListening(true);
      setVoiceNote(null);
    };
    rec.onerror = (e: any) => {
      setListening(false);
      setVoiceNote(`Voice error: ${e?.error ?? "unknown"} — you can type instead.`);
    };
    rec.onend = () => setListening(false);
    rec.onresult = (e: any) => {
      const transcript = Array.from(e.results)
        .map((r: any) => r[0].transcript)
        .join(" ")
        .trim();
      if (transcript) sendInstruction(transcript);
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      setListening(false);
    }
  }

  async function doExport() {
    if (!clips.length) {
      alert("Add at least one clip to the timeline first.");
      return;
    }
    setExporting(true);
    setExportResult(null);
    try {
      const res = await fetch("/api/studio/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timeline: { clips, fps: 30 }, media: bin }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Export failed");
      setExportResult(data);
    } catch (e: any) {
      alert(e.message ?? "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const selected = clips.find((c) => c.id === selectedId) || null;
  const selectedMedia = selected ? bin.find((b) => b.mediaId === selected.mediaId) : null;

  return (
    <div style={{ padding: "20px", maxWidth: 1280, margin: "0 auto" }}>
      {/* Header + mode toggle */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div>
          <div style={{ color: ACCENT, fontSize: 12, letterSpacing: 2, fontWeight: 700 }}>
            EDITING STUDIO
          </div>
          <h1 style={{ fontSize: 22, margin: "4px 0 0", color: TEXT }}>
            Premiere-style editor — manual or AI-driven
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={btn(mode === "manual")} onClick={() => setMode("manual")}>
            🖱️ Manual
          </button>
          <button style={btn(mode === "ai")} onClick={() => setMode("ai")}>
            🤖 AI / Voice
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr 320px", gap: 16 }}>
        {/* ==== LEFT: MEDIA BIN ==== */}
        <div style={panel}>
          <div style={label}>Media Bin</div>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            multiple
            style={{ display: "none" }}
            onChange={(e) => onPickFiles(e.target.files)}
          />
          <button
            style={{ ...btn(true), width: "100%" }}
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "Uploading…" : "+ Import video"}
          </button>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {bin.length === 0 && (
              <div style={{ color: MUTED, fontSize: 12 }}>No media yet — import a clip.</div>
            )}
            {bin.map((m) => (
              <div
                key={m.mediaId}
                style={{ border: `1px solid ${BORDER}`, borderRadius: 8, padding: 8 }}
              >
                <div style={{ color: TEXT, fontSize: 12, wordBreak: "break-word" }}>{m.name}</div>
                <div style={{ color: MUTED, fontSize: 11 }}>
                  {fmt(m.durationSec)}
                  {m.hasAudio ? "" : " · no audio"}
                </div>
                <button
                  style={{ ...btn(), marginTop: 6, width: "100%" }}
                  onClick={() => addToTimeline(m)}
                >
                  + Add to timeline
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* ==== CENTER: MONITOR + TIMELINE ==== */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={panel}>
            <div style={label}>Program Monitor</div>
            <video
              ref={videoRef}
              onTimeUpdate={onTimeUpdate}
              playsInline
              style={{
                width: "100%",
                background: "#000",
                borderRadius: 8,
                aspectRatio: "16/9",
                maxHeight: 420,
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                marginTop: 10,
                flexWrap: "wrap",
              }}
            >
              <button style={btn()} onClick={() => setPlayhead(0)}>
                ⏮
              </button>
              <button style={btn(playing)} onClick={() => setPlaying((p) => !p)}>
                {playing ? "⏸ Pause" : "▶ Play"}
              </button>
              <span style={{ color: MUTED, fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
                {fmt(playhead)} / {fmt(totalDur)}
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(totalDur, 0.01)}
                step={0.01}
                value={Math.min(playhead, totalDur)}
                onChange={(e) => setPlayhead(Number(e.target.value))}
                style={{ flex: 1, minWidth: 120 }}
              />
            </div>
          </div>

          <div style={panel}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={label}>Timeline (V1)</div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={btn()} onClick={splitAtPlayhead} disabled={!clips.length}>
                  ✂ Split at playhead
                </button>
                <button style={btn()} onClick={clearTimeline} disabled={!clips.length}>
                  Clear
                </button>
              </div>
            </div>
            <div
              style={{
                position: "relative",
                height: 56,
                background: "#0E1013",
                border: `1px solid ${BORDER}`,
                borderRadius: 8,
                marginTop: 8,
                overflow: "hidden",
              }}
            >
              {clips.length === 0 && (
                <div style={{ color: MUTED, fontSize: 12, padding: 12 }}>
                  Timeline is empty — add clips from the bin (or ask the AI).
                </div>
              )}
              <div style={{ display: "flex", height: "100%" }}>
                {clips.map((c, i) => {
                  const w = totalDur > 0 ? (clipDuration(c) / totalDur) * 100 : 0;
                  const sel = c.id === selectedId;
                  return (
                    <div
                      key={c.id}
                      onClick={() => setSelectedId(c.id)}
                      style={{
                        width: `${w}%`,
                        minWidth: 24,
                        background: sel ? ACCENT : "#3A4C6B",
                        borderRight: `1px solid ${BG}`,
                        cursor: "pointer",
                        padding: "6px 6px",
                        overflow: "hidden",
                        boxSizing: "border-box",
                      }}
                    >
                      <div
                        style={{
                          color: sel ? "#0B0C0E" : TEXT,
                          fontSize: 11,
                          fontWeight: 700,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {c.text || bin.find((b) => b.mediaId === c.mediaId)?.name || `Clip ${i + 1}`}
                      </div>
                      <div style={{ color: sel ? "#3a2a20" : MUTED, fontSize: 10 }}>
                        {fmt(clipDuration(c))}
                        {c.speed !== 1 ? ` · ${c.speed}×` : ""}
                      </div>
                    </div>
                  );
                })}
              </div>
              {totalDur > 0 && (
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: `${(playhead / totalDur) * 100}%`,
                    width: 2,
                    background: "#fff",
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>
          </div>

          {/* Selected-clip properties — manual detail control */}
          <div style={panel}>
            <div style={label}>
              Clip Properties{selected ? ` — ${selectedMedia?.name ?? ""}` : " (select a clip)"}
            </div>
            {!selected ? (
              <div style={{ color: MUTED, fontSize: 12 }}>
                Click a clip on the timeline to edit its in/out points, speed, volume, text and
                transition.
              </div>
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))",
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ color: MUTED, fontSize: 11 }}>In point (s)</div>
                  <input
                    type="number"
                    step={0.1}
                    value={selected.srcStart}
                    onChange={(e) => updateSelected({ srcStart: Number(e.target.value) })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <div style={{ color: MUTED, fontSize: 11 }}>Out point (s)</div>
                  <input
                    type="number"
                    step={0.1}
                    value={selected.srcEnd}
                    onChange={(e) => updateSelected({ srcEnd: Number(e.target.value) })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <div style={{ color: MUTED, fontSize: 11 }}>Speed ({selected.speed}×)</div>
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.1}
                    value={selected.speed}
                    onChange={(e) => updateSelected({ speed: Number(e.target.value) })}
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <div style={{ color: MUTED, fontSize: 11 }}>
                    Volume ({selected.volume.toFixed(2)})
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.05}
                    value={selected.volume}
                    onChange={(e) => updateSelected({ volume: Number(e.target.value) })}
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <div style={{ color: MUTED, fontSize: 11 }}>Text overlay</div>
                  <input
                    value={selected.text}
                    placeholder="Title on this clip"
                    onChange={(e) => updateSelected({ text: e.target.value })}
                    style={inputStyle}
                  />
                </div>
                <div>
                  <div style={{ color: MUTED, fontSize: 11 }}>Transition</div>
                  <select
                    value={selected.transition}
                    onChange={(e) =>
                      updateSelected({ transition: e.target.value as StudioTransition })
                    }
                    style={inputStyle}
                  >
                    <option value="none">None</option>
                    <option value="fade">Fade</option>
                    <option value="dissolve">Dissolve</option>
                  </select>
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <button style={btn()} onClick={() => moveSelected(-1)}>
                    ← Move
                  </button>
                  <button style={btn()} onClick={() => moveSelected(1)}>
                    Move →
                  </button>
                  <button
                    style={{ ...btn(), background: "#3a1414", borderColor: "#7a2a2a", color: "#FF9B7A" }}
                    onClick={deleteSelected}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Export */}
          <div style={panel}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <button
                style={{ ...btn(true), padding: "10px 18px" }}
                onClick={doExport}
                disabled={exporting || !clips.length}
              >
                {exporting ? "Rendering…" : "⬇️ Export timeline to MP4"}
              </button>
              {exportResult && (
                <a
                  href={exportResult.downloadUrl}
                  style={{ color: ACCENT, fontSize: 13, fontWeight: 700 }}
                >
                  Download exported file
                </a>
              )}
            </div>
            {exportResult && (
              <video
                src={exportResult.url}
                controls
                style={{
                  width: "100%",
                  marginTop: 12,
                  borderRadius: 8,
                  maxHeight: 300,
                  background: "#000",
                }}
              />
            )}
          </div>
        </div>

        {/* ==== RIGHT: AI / CHAT / VOICE ==== */}
        <div style={panel}>
          <div style={label}>AI Editor{mode === "ai" ? " (active)" : ""}</div>
          <div style={{ color: MUTED, fontSize: 12, marginBottom: 10 }}>
            Chat or talk — the AI edits the timeline for you. Switch to Manual to drive it yourself.
          </div>
          <div
            style={{
              height: 360,
              overflowY: "auto",
              background: "#0E1013",
              border: `1px solid ${BORDER}`,
              borderRadius: 8,
              padding: 10,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {messages.length === 0 && (
              <div style={{ color: MUTED, fontSize: 12 }}>
                Try: “add the first clip, cut out the first 3 seconds, speed it up 1.5× and put a
                title ‘Highlight’ on it”.
              </div>
            )}
            {messages.map((m, i) => (
              <div
                key={i}
                style={{
                  alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                  maxWidth: "90%",
                  background: m.role === "user" ? ACCENT : "#1D2024",
                  color: m.role === "user" ? "#0B0C0E" : TEXT,
                  padding: "8px 10px",
                  borderRadius: 10,
                  fontSize: 13,
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.4,
                }}
              >
                {m.content}
              </div>
            ))}
            {aiBusy && <div style={{ color: MUTED, fontSize: 12 }}>…thinking</div>}
          </div>
          {voiceNote && (
            <div style={{ color: "#FF9B7A", fontSize: 12, marginTop: 8 }}>{voiceNote}</div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") sendInstruction(input);
              }}
              placeholder="Tell the AI what to edit…"
              style={inputStyle}
            />
            <button style={btn(true)} onClick={() => sendInstruction(input)} disabled={aiBusy}>
              Send
            </button>
            <button style={btn(listening)} onClick={toggleVoice} title="Voice input">
              {listening ? "●" : "🎤"}
            </button>
          </div>
          <div style={{ color: MUTED, fontSize: 11, marginTop: 8 }}>
            Voice uses your browser’s speech recognition (Chrome/Edge). The AI runs on your NVIDIA
            GLM model.
          </div>
        </div>
      </div>
    </div>
  );
}



