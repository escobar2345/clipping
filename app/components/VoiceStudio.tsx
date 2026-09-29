"use client";

import React, { useEffect, useRef, useState } from "react";

const ACCENT = "#FF5A1F";
const PANEL = "#15171A";
const BORDER = "#2A2D31";

const stepStyle: React.CSSProperties = {
  background: PANEL,
  border: `1px solid ${BORDER}`,
  borderRadius: 10,
  padding: 24,
  marginBottom: 20,
};

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

const buttonStyle: React.CSSProperties = {
  background: ACCENT,
  color: "#0B0C0E",
  border: "none",
  borderRadius: 6,
  padding: "10px 18px",
  fontWeight: 700,
  fontSize: 14,
  cursor: "pointer",
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

// 23 languages supported by the Chatterbox multilingual V3 model.
const LANGUAGES: Array<[code: string, label: string]> = [
  ["ar", "Arabic"], ["da", "Danish"], ["de", "German"], ["el", "Greek"],
  ["en", "English"], ["es", "Spanish"], ["fi", "Finnish"], ["fr", "French"],
  ["he", "Hebrew"], ["hi", "Hindi"], ["it", "Italian"], ["ja", "Japanese"],
  ["ko", "Korean"], ["ms", "Malay"], ["nl", "Dutch"], ["no", "Norwegian"],
  ["pl", "Polish"], ["pt", "Portuguese"], ["ru", "Russian"], ["sv", "Swedish"],
  ["sw", "Swahili"], ["tr", "Turkish"], ["zh", "Chinese"],
];

type Health = {
  status?: string;
  ready?: boolean;
  device?: string;
  modelsLoaded?: string[];
  error?: string | null;
};

type GenResult = {
  url: string;
  file: string;
  sizeMb: number;
  sr: number;
  duration: number;
  model: string;
  created: string;
  kind: "tts" | "vc";
};

type VoiceFile = { file: string; url: string; sizeMb: number; modified: string; kind: "tts" | "vc" };

export default function VoiceStudio() {
  const [tool, setTool] = useState<"tts" | "vc">("tts");

  // TTS form state
  const [text, setText] = useState(
    "Hey there! Welcome to the Voice Studio. Type anything here and I'll read it out loud for you."
  );
  const [model, setModel] = useState<"multilingual" | "base" | "turbo" | "nano">("multilingual");
  const [language, setLanguage] = useState("en");
  const [exaggeration, setExaggeration] = useState(0.5);
  const [cfgWeight, setCfgWeight] = useState(0.5);
  const [temperature, setTemperature] = useState(0.8);
  const [voiceRef, setVoiceRef] = useState<File | null>(null);
  const voiceRefInput = useRef<HTMLInputElement>(null);

  // VC form state
  const [vcAudio, setVcAudio] = useState<File | null>(null);
  const [vcTarget, setVcTarget] = useState<File | null>(null);
  const vcAudioInput = useRef<HTMLInputElement>(null);
  const vcTargetInput = useRef<HTMLInputElement>(null);

  // Status / results
  const [health, setHealth] = useState<Health | null>(null);
  const [checking, setChecking] = useState(true);
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenResult | null>(null);
  const [files, setFiles] = useState<VoiceFile[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);

  async function refreshStatus() {
    setChecking(true);
    try {
      const res = await fetch("/api/voice/status");
      const data = await res.json();
      setHealth(data);
    } catch (e: any) {
      setHealth({ status: "unavailable", error: e?.message ?? String(e) });
    } finally {
      setChecking(false);
    }
  }

  async function refreshFiles() {
    try {
      const res = await fetch("/api/voice/files");
      const data = await res.json();
      if (Array.isArray(data.files)) setFiles(data.files);
    } catch {
      /* files list is optional */
    }
  }

  useEffect(() => {
    refreshStatus();
    refreshFiles();
  }, []);

  async function handleGenerateTTS() {
    if (!text.trim()) {
      setError("Enter some text to synthesize first.");
      return;
    }
    setError(null);
    setLoading("tts");
    try {
      const form = new FormData();
      form.append("text", text);
      form.append("model", model);
      form.append("language", language);
      form.append("exaggeration", String(exaggeration));
      form.append("cfg_weight", String(cfgWeight));
      form.append("temperature", String(temperature));
      if (voiceRef) form.append("voice_ref", voiceRef);

      const res = await fetch("/api/voice/tts", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Generation failed.");
      setResult({ ...data, kind: "tts" });
      refreshFiles();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handleConvert() {
    if (!vcAudio) {
      setError("Upload an audio file to convert first.");
      return;
    }
    setError(null);
    setLoading("vc");
    try {
      const form = new FormData();
      form.append("audio", vcAudio);
      if (vcTarget) form.append("target_voice", vcTarget);

      const res = await fetch("/api/voice/vc", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Conversion failed.");
      setResult({ ...data, kind: "vc" });
      refreshFiles();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handleDelete(file: string) {
    setDeleting(file);
    try {
      const res = await fetch("/api/voice/files", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Delete failed");
      if (Array.isArray(data.files)) setFiles(data.files);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDeleting(null);
    }
  }

  function fmtDuration(sec: number) {
    if (!Number.isFinite(sec) || sec <= 0) return "";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  const ready = health?.ready === true || health?.status === "ready";

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 20px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ color: ACCENT, fontSize: 12, letterSpacing: 2, fontWeight: 700, marginBottom: 6 }}>
          VOICE STUDIO
        </div>
        <h1 style={{ fontSize: 28, margin: 0, fontWeight: 700 }}>Voice over &amp; voice cloning.</h1>
        <p style={{ color: "#8A8D93", marginTop: 8, fontSize: 14 }}>
          Powered by the local Chatterbox engine. Type text to make a voice over, clone a
          voice from a short reference clip, or re-voice an existing recording.
        </p>
      </div>

      {/* Bridge status / setup guidance */}
      <div
        style={{
          ...stepStyle,
          borderColor: ready ? "#2E7D4F" : health?.status === "unavailable" ? "#8C2E1F" : BORDER,
          background: ready ? "#0F2016" : health?.status === "unavailable" ? "#20120D" : PANEL,
        }}
      >
        {checking ? (
          <span style={{ color: "#8A8D93", fontSize: 13 }}>Checking voice engine…</span>
        ) : ready ? (
          <span style={{ color: "#7BD88F", fontSize: 13, fontWeight: 600 }}>
            ✓ Voice engine ready{health?.device ? ` · running on ${health.device}` : ""}
            {health?.modelsLoaded?.length ? ` · loaded: ${health.modelsLoaded.join(", ")}` : ""}
          </span>
        ) : (
          <span style={{ color: "#FF9B7A", fontSize: 13, display: "block", marginBottom: 6, fontWeight: 700 }}>
            Voice engine needs setup on this machine
          </span>
        )}
        {!checking && !ready && (
          <p style={{ fontSize: 13, color: "#E8E6E1", margin: "8px 0 10px", whiteSpace: "pre-line" }}>
            {health?.status === "unavailable"
              ? `${/Railway web service/i.test(health?.error ?? "")
                  ? "Voice engine is turned off on this Railway deploy (Node-only, no Python by design).\n\nUse the 🎬 Video Studio tab here — it works fine. For voice-overs, run the app on your own PC (`npm run dev`) after `pip install -r voice-server/requirements.txt`."
                  : `Could not reach the Python voice server.\n\n${health?.error ?? ""}`}`
              : `The Python bridge server started but Chatterbox isn't installed yet.\n\n${health?.error ?? ""}`}
          </p>
        )}
        {!checking && !ready && !/Railway web service/i.test(health?.error ?? "") && (
          <code
            style={{
              display: "block",
              background: "#0F1012",
              border: `1px solid ${BORDER}`,
              borderRadius: 6,
              padding: "10px 12px",
              fontSize: 12,
              color: "#E8E6E1",
              margin: "10px 0",
              whiteSpace: "pre-wrap",
            }}
          >
            {`# on your server / Railway, from the project root:\npython -m pip install -r voice-server/requirements.txt\n# (or)\npip install chatterbox-tts flask`}
          </code>
        )}
        <button
          style={checking ? buttonDisabled : { ...buttonStyle, padding: "6px 12px", fontSize: 12 }}
          disabled={checking}
          onClick={refreshStatus}
        >
          {checking ? "Checking…" : "Refresh status"}
        </button>
      </div>

      {error && (
        <div style={{ ...stepStyle, borderColor: "#8C2E1F", background: "#20120D", color: "#FF9B7A" }}>
          {error}
        </div>
      )}

      {/* Tool tabs */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button
          style={tool === "tts" ? buttonStyle : { ...buttonStyle, background: "#2A2D31", color: "#E8E6E1" }}
          onClick={() => setTool("tts")}
        >
          Text to speech
        </button>
        <button
          style={tool === "vc" ? buttonStyle : { ...buttonStyle, background: "#2A2D31", color: "#E8E6E1" }}
          onClick={() => setTool("vc")}
        >
          Voice conversion
        </button>
      </div>
{tool === "tts" ? (
        <section style={stepStyle}>
          <span style={labelStyle}>01 · Model</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 }}>
            {(
              [
                ["multilingual", "Multilingual (23 languages)"],
                ["base", "Base (English)"],
                ["turbo", "Turbo (fast English)"],
                ["nano", "Nano (lightweight English)"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  fontSize: 12,
                  padding: "6px 10px",
                  borderRadius: 999,
                  border: `1px solid ${model === value ? ACCENT : BORDER}`,
                  background: model === value ? "#241407" : "transparent",
                  color: model === value ? ACCENT : "#E8E6E1",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
                onClick={() => setModel(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {model === "multilingual" && (
            <>
              <span style={labelStyle}>01b · Language</span>
              <select
                style={{ ...inputStyle, width: 260, marginBottom: 20 }}
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {LANGUAGES.map(([code, label]) => (
                  <option key={code} value={code}>
                    {label} ({code})
                  </option>
                ))}
              </select>
            </>
          )}

          <span style={labelStyle}>02 · Your script</span>
          <textarea
            style={{ ...inputStyle, minHeight: 110, resize: "vertical" }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Type the words you want turned into speech…"
          />

          <span style={{ ...labelStyle, marginTop: 16 }}>03 · Voice reference (voice cloning — optional)</span>
          <p style={{ fontSize: 12, color: "#8A8D93", margin: "0 0 8px" }}>
            Leave empty for the default voice. Upload a clear <b>5–10 second</b> clip of the
            voice you want to clone (wav / mp3 / m4a).
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20 }}>
            <input
              ref={voiceRefInput}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.flac"
              style={{ display: "none" }}
              onChange={(e) => setVoiceRef(e.target.files?.[0] ?? null)}
            />
            <button
              style={{ ...buttonStyle, background: "#2A2D31", color: "#E8E6E1" }}
              onClick={() => voiceRefInput.current?.click()}
            >
              {voiceRef ? "Change voice clip" : "Upload voice clip"}
            </button>
            {voiceRef && (
              <>
                <span style={{ fontSize: 13, color: "#8A8D93" }}>{voiceRef.name}</span>
                <button
                  style={{ ...dangerButton, background: "transparent", border: `1px solid ${BORDER}` }}
                  onClick={() => {
                    setVoiceRef(null);
                    if (voiceRefInput.current) voiceRefInput.current.value = "";
                  }}
                >
                  Remove
                </button>
              </>
            )}
          </div>
<span style={labelStyle}>04 · Voice tuning</span>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
            <div>
              <label style={{ fontSize: 12, color: "#8A8D93", display: "block", marginBottom: 4 }}>
                Exaggeration · {exaggeration.toFixed(2)}
              </label>
              <input
                type="range" min={0.25} max={2} step={0.05} value={exaggeration}
                onChange={(e) => setExaggeration(Number(e.target.value))}
                style={{ width: "100%" }}
              />
              <div style={{ fontSize: 11, color: "#5C5F66" }}>0.5 neutral · higher = more expressive</div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#8A8D93", display: "block", marginBottom: 4 }}>
                CFG / pace · {cfgWeight.toFixed(2)}
              </label>
              <input
                type="range" min={0} max={1} step={0.05} value={cfgWeight}
                onChange={(e) => setCfgWeight(Number(e.target.value))}
                style={{ width: "100%" }}
              />
              <div style={{ fontSize: 11, color: "#5C5F66" }}>0.5 default · lower = slower/deliberate</div>
            </div>
            <div>
              <label style={{ fontSize: 12, color: "#8A8D93", display: "block", marginBottom: 4 }}>
                Temperature · {temperature.toFixed(2)}
              </label>
              <input
                type="range" min={0.05} max={5} step={0.05} value={temperature}
                onChange={(e) => setTemperature(Number(e.target.value))}
                style={{ width: "100%" }}
              />
              <div style={{ fontSize: 11, color: "#5C5F66" }}>0.8 default · higher = more varied</div>
            </div>
          </div>

          <button
            style={loading === "tts" ? buttonDisabled : buttonStyle}
            disabled={loading === "tts"}
            onClick={handleGenerateTTS}
          >
            {loading === "tts"
              ? "Generating… (first run downloads the model — can take minutes)"
              : voiceRef
                ? "Generate with cloned voice"
                : "Generate voice over"}
          </button>
        </section>
      ) : (
        <section style={stepStyle}>
          <span style={labelStyle}>01 · Audio to convert</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20 }}>
            <input
              ref={vcAudioInput}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.flac"
              style={{ display: "none" }}
              onChange={(e) => setVcAudio(e.target.files?.[0] ?? null)}
            />
            <button style={{ ...buttonStyle, background: "#2A2D31", color: "#E8E6E1" }} onClick={() => vcAudioInput.current?.click()}>
              {vcAudio ? "Change audio" : "Upload audio"}
            </button>
            {vcAudio && <span style={{ fontSize: 13, color: "#8A8D93" }}>{vcAudio.name}</span>}
          </div>

          <span style={labelStyle}>02 · Target voice (who it should sound like — optional)</span>
          <p style={{ fontSize: 12, color: "#8A8D93", margin: "0 0 8px" }}>
            Leave empty to use the engine&apos;s default voice.
          </p>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 20 }}>
            <input
              ref={vcTargetInput}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.flac"
              style={{ display: "none" }}
              onChange={(e) => setVcTarget(e.target.files?.[0] ?? null)}
            />
            <button style={{ ...buttonStyle, background: "#2A2D31", color: "#E8E6E1" }} onClick={() => vcTargetInput.current?.click()}>
              {vcTarget ? "Change target voice" : "Upload target voice"}
            </button>
            {vcTarget && <span style={{ fontSize: 13, color: "#8A8D93" }}>{vcTarget.name}</span>}
          </div>

          <button
            style={loading === "vc" ? buttonDisabled : buttonStyle}
            disabled={loading === "vc"}
            onClick={handleConvert}
          >
            {loading === "vc" ? "Converting…" : "Convert voice"}
          </button>
        </section>
      )}

{/* Latest result */}
      {result && (
        <section style={{ ...stepStyle, borderColor: "#2E7D4F", background: "#0F2016" }}>
          <span style={{ ...labelStyle, color: "#7BD88F" }}>
            {result.kind === "tts" ? "Generated voice over" : "Converted audio"} ·{" "}
            {fmtDuration(result.duration) || `${result.duration}s`} · {result.sizeMb} MB
            {result.model ? ` · ${result.model}` : ""}
          </span>
          <audio controls style={{ width: "100%", margin: "8px 0 12px" }} src={result.url} />
          <div style={{ display: "flex", gap: 8 }}>
            <a
              href={result.url}
              download
              style={{ ...buttonStyle, textDecoration: "none", display: "inline-block" }}
            >
              Download .wav
            </a>
            <button
              style={{ ...buttonStyle, background: "#2A2D31", color: "#E8E6E1" }}
              onClick={() => setResult(null)}
            >
              Dismiss
            </button>
          </div>
        </section>
      )}

      {/* History of generated voices */}
      {files.length > 0 && (
        <section style={stepStyle}>
          <span style={labelStyle}>Recent files (public/voice)</span>
          {files.map((f) => (
            <div
              key={f.file}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 0",
                borderTop: `1px solid ${BORDER}`,
              }}
            >
              <span style={{ fontSize: 13, color: "#E8E6E1", flex: 1, minWidth: 0 }}>
                {f.kind === "vc" ? "🎙️ VC" : "🗣️ TTS"} · {f.file}
                <span style={{ color: "#8A8D93" }}>
                  {" "}
                  · {f.sizeMb} MB · {new Date(f.modified).toLocaleString()}
                </span>
              </span>
              <audio controls preload="none" style={{ height: 32, width: 200 }} src={f.url} />
              <a href={f.url} download style={{ ...buttonStyle, padding: "6px 12px", fontSize: 12, textDecoration: "none" }}>
                Save
              </a>
              <button
                style={deleting === f.file ? { ...dangerButton, opacity: 0.5 } : dangerButton}
                disabled={deleting === f.file}
                onClick={() => handleDelete(f.file)}
              >
                {deleting === f.file ? "…" : "Delete"}
              </button>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}