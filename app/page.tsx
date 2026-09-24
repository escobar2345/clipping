"use client";

import React, { useState, useEffect } from "react";
import type { VideoIntel, StyleProfile, EditRules, EditPlan } from "../lib/types";
import { editedDurationSec } from "../lib/timeline";
import type { PublicAccount, AccountChannels, PostResponse, TunnelInfo } from "../lib/clientTypes";
import type { ConfigStatus } from "../lib/config";
import AccountsManager from "./components/AccountsManager";
import CaptionCoach from "./components/CaptionCoach";
import AnalyticsPanel from "./components/AnalyticsPanel";
import ChatPanel from "./components/ChatPanel";

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

// Small destructive-action button (delete rendered clip / stored video).
const dangerButton: React.CSSProperties = {
  ...buttonStyle,
  background: "#8C2E1F",
  color: "#FFE1D6",
  padding: "6px 12px",
  fontSize: 12,
};

const dangerButtonDisabled: React.CSSProperties = {
  ...dangerButton,
  background: "#33211C",
  color: "#8A6E64",
  cursor: "not-allowed",
};

function chipStyle(checked: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    fontSize: 12,
    padding: "6px 10px",
    borderRadius: 999,
    border: `1px solid ${checked ? ACCENT : BORDER}`,
    background: checked ? "#241407" : "transparent",
    color: checked ? ACCENT : "#E8E6E1",
    cursor: "pointer",
    userSelect: "none",
  };
}

type ExistingRender = {
  file: string;
  url: string;
  sizeMb: number;
  modified: string;
  sourceUrl?: string | null;
  sourceFile?: string | null;
  sourceStartSec?: number | null;
  sourceEndSec?: number | null;
  hookTitle?: string | null;
};

// One source video file stored in public/uploads (URL downloads + uploads).
type StoredUpload = {
  file: string;
  url: string;
  sizeMb: number;
  modified: string;
};

/** Extracts the YouTube video id from any common URL shape (for matching
 *  rendered files to the current video regardless of URL format). */
function ytId(url: string | null | undefined): string {
  if (!url) return "";
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : url;
}

export default function Page() {
  const [youtubeUrl, setYoutubeUrl] = useState("");
  // Step 01 alternative to pasting a URL: a video file chosen on this computer.
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sampleFile, setSampleFile] = useState<File | null>(null);
  const [rulesText, setRulesText] = useState(
    "Prioritize the most quotable, self-contained moments. Keep energy high from the first second."
  );
  const [targetClipCount, setTargetClipCount] = useState(3);
  const [minSec, setMinSec] = useState(20);
  const [maxSec, setMaxSec] = useState(60);

  const [intel, setIntel] = useState<VideoIntel | null>(null);
  // True when analyze returned metadata but the video FILE still needs to be
  // downloaded (that happens lazily at render time — see /api/render).
  const [filePending, setFilePending] = useState(false);
  const [styleProfile, setStyleProfile] = useState<StyleProfile | null>(null);
  const [editPlan, setEditPlan] = useState<EditPlan | null>(null);
  const [renderedUrls, setRenderedUrls] = useState<Record<number, string>>({});
  const [existingRenders, setExistingRenders] = useState<ExistingRender[]>([]);
  // Source videos cached on this machine (public/uploads) — deletable.
  const [storedUploads, setStoredUploads] = useState<StoredUpload[]>([]);

  const [accountChannels, setAccountChannels] = useState<AccountChannels[]>([]);
  const [savedAccounts, setSavedAccounts] = useState<PublicAccount[]>([]);
  // Per clip: which channels (across WHICH accounts) are checked for posting.
  // Key format: "<accountId>:<channelId>"
  const [selectedTargets, setSelectedTargets] = useState<Record<number, Record<string, boolean>>>({});
  const [caption, setCaption] = useState<Record<number, string>>({});
  // Per clip: your free-text instructions to the AI about WHAT the post should
  // say ("tell the AI what to post") — drafted into caption[i] before posting.
  const [postBrief, setPostBrief] = useState<Record<number, string>>({});
  const [postMode, setPostMode] = useState<Record<number, "queue" | "schedule">>({});
  const [dueAt, setDueAt] = useState<Record<number, string>>({});
  const [postResult, setPostResult] = useState<Record<number, string>>({});

  async function refreshAccountsAndChannels() {
    try {
      const [chRes, acRes] = await Promise.all([
        fetch("/api/buffer/channels"),
        fetch("/api/accounts"),
      ]);
      const chData = await chRes.json();
      const acData = await acRes.json();
      if (Array.isArray(chData.accounts)) setAccountChannels(chData.accounts);
      if (Array.isArray(acData.accounts)) setSavedAccounts(acData.accounts);
    } catch {
      /* account/channel lists are optional at load time — surfaced when posting */
    }
  }

  async function refreshRenders() {
    try {
      const r = await fetch("/api/renders");
      const d = await r.json();
      if (Array.isArray(d.renders)) setExistingRenders(d.renders);
    } catch {
      /* renders list is optional at load time */
    }
  }

  async function refreshUploads() {
    try {
      const r = await fetch("/api/uploads");
      const d = await r.json();
      if (Array.isArray(d.uploads)) setStoredUploads(d.uploads);
    } catch {
      /* stored-video list is optional at load time */
    }
  }

  useEffect(() => {
    refreshAccountsAndChannels();
    refreshRenders();
    refreshUploads();
  }, []);

  // If a render for the CURRENT video already exists on disk, surface it in the
  // per-clip player immediately — no re-render needed. The source match prevents
  // a stale clip from a DIFFERENT video from ever showing up or being posted.
  // For URL videos we match on the (normalized) YouTube id; uploaded videos have
  // no URL, so we match on the source upload-file basename instead.
  useEffect(() => {
    if (!editPlan || existingRenders.length === 0) return;
    const currentId = ytId(intel?.sourceUrl);
    const currentFile = currentUploadFile();
    const matching = new Set(
      existingRenders
        .filter((r) =>
          currentId
            ? ytId(r.sourceUrl) === currentId
            : Boolean(currentFile) && r.sourceFile === currentFile
        )
        .map((r) => r.file)
    );
    if (matching.size === 0) return;
    setRenderedUrls((prev) => {
      const next = { ...prev };
      editPlan.clips.forEach((clip, i) => {
        const file = `${clip.clipId}.mp4`;
        if (!next[i] && matching.has(file)) next[i] = `/renders/${file}`;
      });
      return next;
    });
  }, [editPlan, intel, existingRenders]);

  function toggleTarget(clipIndex: number, key: string) {
    setSelectedTargets((prev) => ({
      ...prev,
      [clipIndex]: { ...(prev[clipIndex] ?? {}), [key]: !prev[clipIndex]?.[key] },
    }));
  }

  function selectedCount(clipIndex: number): number {
    return Object.values(selectedTargets[clipIndex] ?? {}).filter(Boolean).length;
  }

  // Platforms the coach should tailor captions for: those checked on the target
  // clip, or every connected platform as fallback.
  function coachPlatforms(clipIndex: number): string[] {
    const selected = new Set<string>();
    for (const a of accountChannels) {
      for (const c of a.channels) {
        if (selectedTargets[clipIndex]?.[`${a.account.id}:${c.id}`]) selected.add(c.service);
      }
    }
    if (selected.size > 0) return Array.from(selected);
    return accountChannels.flatMap((a) => a.channels.map((c) => c.service));
  }

  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which clip the caption-coach suggestions get written into.
  const [coachTargetClip, setCoachTargetClip] = useState(0);
  // Setup diagnostics — env vars that must be configured for the pipeline to run.
  const [configStatus, setConfigStatus] = useState<ConfigStatus | null>(null);
  // The AI's own system prompt — editable (advanced). Saved server-side; an
  // empty box falls back to the built-in concise default.
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  // Which public URL Buffer will fetch rendered videos from (deployed domain
  // or the auto-ngrok tunnel). Passive status; the tunnel starts on posting.
  const [publicUrl, setPublicUrl] = useState<TunnelInfo | null>(null);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d) => setConfigStatus(d.status ?? null))
      .catch(() => {
        /* non-fatal */
      });
    fetch("/api/prompts")
      .then((r) => r.json())
      .then((d) => d.systemPrompt && setSystemPrompt(d.systemPrompt))
      .catch(() => {
        /* non-fatal */
      });
    fetch("/api/tunnel")
      .then((r) => r.json())
      .then((d: TunnelInfo) => setPublicUrl(d))
      .catch(() => {
        /* non-fatal */
      });
  }, []);

  // Every API call gets a hard client-side timeout so the UI can never spin
  // forever (the original "stuck on Fetching…" bug): analyze ~2.5min (Apify
  // actor run), plan ~2min (GLM), render 10min (download + Remotion render).
  async function callApi(url: string, body: any, timeoutMs = 120_000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      return data;
    } catch (e: any) {
      if (e?.name === "AbortError") {
        throw new Error(
          `The server did not respond within ${Math.round(timeoutMs / 1000)}s. ` +
            `Check the dev-server log, then try again — if this keeps happening ` +
            `the step may be failing on the server before it can reply.`
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function handleAnalyze() {
    setError(null);
    setLoading("analyze");
    try {
      const data = await callApi(
        "/api/analyze",
        { youtubeUrl, url: youtubeUrl },
        150_000
      );
      setIntel(data.intel);
      // Analyze is metadata-only — the actual video file downloads lazily at
      // render time. Tell the user so the render step's extra wait isn't a
      // surprise.
      setFilePending(Boolean(data.videoFilePending));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handleUpload() {
    if (!sourceFile) return;
    setError(null);
    setLoading("upload");
    try {
      // Multipart upload — /api/upload saves the file into public/uploads and
      // returns the same intel shape as /api/analyze. The video FILE is
      // already on the server, so render needs no download at all.
      const form = new FormData();
      form.append("file", sourceFile);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 900_000); // big files, slow lines
      let data: any;
      try {
        const res = await fetch("/api/upload", {
          method: "POST",
          body: form,
          signal: ctrl.signal,
        });
        data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Upload failed");
      } finally {
        clearTimeout(timer);
      }
      setIntel(data.intel);
      setFilePending(Boolean(data.videoFilePending));
      // Keep exactly one active source: drop any pasted URL and any edit
      // plan / renders that belong to a previous video.
      setYoutubeUrl("");
      setEditPlan(null);
      setRenderedUrls({});
      refreshUploads(); // the freshly uploaded file now shows in storage
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setError(
          "The upload did not finish within 15 minutes — try a smaller file or a faster connection."
        );
      } else {
        setError(e.message);
      }
    } finally {
      setLoading(null);
    }
  }

  async function handleStyleProfile() {
    if (!sampleFile) return;
    setError(null);
    setLoading("style");
    try {
      // Upload the reference clip as multipart form-data. Frames are extracted
      // locally with ffmpeg and read by the vision model — no Apify, no URL.
      const form = new FormData();
      form.append("file", sampleFile);
      const res = await fetch("/api/style-profile", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Style extraction failed");
      setStyleProfile(data.styleProfile);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function resetSystemPrompt() {
    try {
      const res = await fetch("/api/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt: null }),
      });
      const d = await res.json();
      if (d.systemPrompt) setSystemPrompt(d.systemPrompt);
    } catch {
      /* non-fatal */
    }
  }

  // The stored file (basename) backing the currently loaded video, e.g.
  // "up-1a2b3c4d5e6f.mp4" from intel.videoFilePath …/uploads/<file>.
  function currentUploadFile(): string {
    const p = intel?.videoFilePath ?? "";
    return p ? p.split("/").pop() ?? "" : "";
  }

  async function handleDeleteRender(file: string) {
    if (
      !confirm(
        `Delete the rendered clip "${file}" from this machine?\n\n` +
          `If this exact clip is queued or scheduled in Buffer and has NOT published ` +
          `yet, that post will fail when Buffer tries to fetch the file. Posts that ` +
          `already published are unaffected.`
      )
    )
      return;
    setError(null);
    setLoading(`del-render-${file}`);
    try {
      const res = await fetch("/api/renders", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Delete failed");
      // If a per-clip player above is showing exactly this file, unhook it so
      // the UI never points at a deleted video.
      const dead = `/renders/${file}`;
      setRenderedUrls((prev) => {
        const next: Record<number, string> = {};
        for (const [k, v] of Object.entries(prev)) {
          if (v !== dead) next[Number(k)] = v;
        }
        return next;
      });
      refreshRenders();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  // Carry-over: after a reload the app forgot which video you loaded, but the
  // file is still stored — load it back into Step 01 without re-uploading.
  async function handleLoadUpload(file: string) {
    setError(null);
    setLoading(`load-${file}`);
    try {
      const res = await fetch("/api/uploads/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Load failed");
      setIntel(data.intel);
      setFilePending(Boolean(data.videoFilePending));
      setYoutubeUrl("");
      setSourceFile(null);
      setEditPlan(null);
      setRenderedUrls({});
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handleDeleteUpload(file: string) {
    if (
      !confirm(
        `Delete the stored source video "${file}" from this machine?\n\n` +
          `You'd have to upload it (or re-analyze its URL) to render new clips from ` +
          `it. Nothing already queued in Buffer is affected.`
      )
    )
      return;
    setError(null);
    setLoading(`del-upload-${file}`);
    try {
      const res = await fetch("/api/uploads", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Delete failed");
      refreshUploads();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handleGeneratePlan() {
    if (!intel) return;
    setError(null);
    setLoading("plan");
    try {
      const rules: EditRules = {
        instructions: rulesText,
        targetClipCount,
        minClipSec: minSec,
        maxClipSec: maxSec,
        aspect: "9:16",
      };
      // Uploaded files have no transcript, so the server analyzes the WHOLE
      // video visually (ffmpeg scene scan + vision model) before GLM plans —
      // that legitimately takes 1–4 minutes on longer files. The server's
      // cap is 300s (maxDuration) — the client must wait that long too,
      // otherwise it aborts the request right as the server finishes.
      const data = await callApi(
        "/api/edit-plan",
        {
          intel,
          rules,
          styleProfile: styleProfile ?? undefined,
          systemPrompt,
        },
        300_000
      );
      setEditPlan(data.editPlan);
      setRenderedUrls({});
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handleRender(clipIndex: number) {
    if (!editPlan) return;
    setError(null);
    setLoading(`render-${clipIndex}`);
    try {
      const data = await callApi(
        "/api/render",
        {
          editPlan,
          clipIndex,
          sourceUrl: intel?.sourceUrl ?? "",
        },
        600_000
      );
      setRenderedUrls((prev) => ({ ...prev, [clipIndex]: data.url }));
      refreshRenders();
      setCaption((prev) => ({
        ...prev,
        [clipIndex]: prev[clipIndex] ?? editPlan.clips[clipIndex].hookTitle,
      }));
      setPostMode((prev) => ({ ...prev, [clipIndex]: prev[clipIndex] ?? "queue" }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handleDraftCaption(clipIndex: number) {
    const brief = (postBrief[clipIndex] ?? "").trim();
    if (!brief) return;
    setError(null);
    setLoading(`draft-${clipIndex}`);
    try {
      // Reuse the same AI caption engine as the Caption Coach panel, but skip
      // the Apify web research (saves credits) — the user just wants a draft
      // from their own brief right next to the post button.
      const platforms = coachPlatforms(clipIndex);
      const data = await callApi(
        "/api/coach/caption",
        {
          topic: brief,
          draftCaption: caption[clipIndex] ?? "",
          platforms: platforms.length ? platforms : ["instagram"],
          skipResearch: true,
        },
        180_000
      );
      const first = data?.captions?.[0];
      if (!first?.caption) throw new Error(data?.error ?? "No caption drafted");
      setCaption((prev) => ({ ...prev, [clipIndex]: first.caption }));
      setPostResult((prev) => ({
        ...prev,
        [clipIndex]: `✏ Drafted a ${first.platform} caption from your brief — review & edit above, then post.`,
      }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  async function handlePostToBuffer(clipIndex: number) {
    const renderedPath = renderedUrls[clipIndex];
    const mode = postMode[clipIndex] ?? "queue";
    const checks = selectedTargets[clipIndex] ?? {};
    const targets = Object.entries(checks)
      .filter(([, on]) => on)
      .map(([key]) => {
        const splitAt = key.indexOf(":");
        return {
          accountId: key.slice(0, splitAt),
          channelId: key.slice(splitAt + 1),
        };
      });
    if (!renderedPath || targets.length === 0) return;

    setError(null);
    setLoading(`post-${clipIndex}`);
    try {
      // One request fans out concurrently to EVERY selected channel across
      // EVERY selected Buffer account (see /api/buffer/post).
      const data: PostResponse = await callApi("/api/buffer/post", {
        renderedPath,
        targets,
        caption: caption[clipIndex] ?? "",
        mode,
        dueAtIso: mode === "schedule" ? new Date(dueAt[clipIndex]).toISOString() : undefined,
      });
      setPostResult((prev) => ({
        ...prev,
        [clipIndex]: `Queued on ${data.summary.succeeded}/${data.summary.total} channels${
          data.summary.failed > 0 ? ` · ${data.summary.failed} failed` : ""
        } ✓`,
      }));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(null);
    }
  }

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "48px 20px", fontFamily: "system-ui, sans-serif" }}>
      <div style={{ marginBottom: 32 }}>
        <div style={{ color: ACCENT, fontSize: 12, letterSpacing: 2, fontWeight: 700, marginBottom: 6 }}>
          LONG2SHORT
        </div>
        <h1 style={{ fontSize: 28, margin: 0, fontWeight: 700 }}>Long-form in. Short-form out.</h1>
        <p style={{ color: "#8A8D93", marginTop: 8, fontSize: 14 }}>
          Paste a video link or upload a file from your computer. GLM plans the edit,
          Remotion renders it. Post to unlimited Buffer accounts simultaneously.
        </p>
      </div>

      {error && (
        <div style={{ ...stepStyle, borderColor: "#8C2E1F", background: "#20120D", color: "#FF9B7A" }}>
          {error}
        </div>
      )}

      {configStatus && configStatus.missing.length > 0 && (
        <div style={{ ...stepStyle, borderColor: "#8C2E1F", background: "#20120D", marginBottom: 20 }}>
          <span style={{ color: "#FF9B7A", fontWeight: 700, fontSize: 14, display: "block", marginBottom: 6 }}>
            Setup incomplete — {configStatus.missing.length} environment key{configStatus.missing.length === 1 ? "" : "s"} missing
          </span>
          <p style={{ fontSize: 13, color: "#E8E6E1", margin: "0 0 10px" }}>
            The pipeline can&apos;t run until these are in <code style={{ color: "#FF9B7A" }}>.env.local</code> (see{" "}
            <code style={{ color: "#FF9B7A" }}>.env.local.example</code>). You saw a 500 on “Analyze video” because
            step 1 needs the Apify keys.
          </p>
          <ul style={{ margin: 0, paddingInlineStart: 20, fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
            {configStatus.missing.map((m) => (
              <li key={m.key} style={{ color: "#E8E6E1" }}>
                <code style={{ color: "#FF9B7A" }}>{m.key}</code> — {m.label}. Get it at: {m.hint}
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 12, color: "#8A8D93", margin: "10px 0 0" }}>
            After adding them to <code>.env.local</code>, restart the dev server (Ctrl+C, then <code>npm run dev</code>) and reload.
          </p>
        </div>
      )}

      {/* Public-URL status — Buffer fetches the rendered .mp4 from this URL.
          "none" is fine: posting auto-starts an ngrok tunnel. */}
      {publicUrl && (
        <div style={{ ...stepStyle, marginBottom: 20 }}>
          <span style={labelStyle}>Public URL for posting</span>
          {publicUrl.url ? (
            <p style={{ fontSize: 13, color: "#9FD9A8", margin: 0 }}>
              Buffer will fetch videos from{" "}
              <a
                href={publicUrl.url}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#7CE38B", fontWeight: 600 }}
              >
                {publicUrl.url}
              </a>
              {publicUrl.mode === "ngrok"
                ? " — auto-ngrok tunnel. Keep this app running until your posts publish; Buffer re-fetches the video at publish time."
                : " — from NEXT_PUBLIC_BASE_URL when the video is reachable there; videos that only exist on this machine are served through an automatic ngrok tunnel instead."}
            </p>
          ) : (
            <p style={{ fontSize: 13, color: "#FFD37A", margin: 0 }}>{publicUrl.note}</p>
          )}
        </div>
      )}

      {/* Multi-account Buffer management — add/remove API keys, see channels */}
      <AccountsManager accounts={accountChannels} savedAccounts={savedAccounts} onChanged={refreshAccountsAndChannels} />

      {/* Step 1: source video */}
      <section style={stepStyle}>
        <span style={labelStyle}>01 · Source video</span>
        <input
          style={inputStyle}
          placeholder="Video URL — YouTube, TikTok, Instagram, Facebook, X, Vimeo, direct mp4…"
          value={youtubeUrl}
          onChange={(e) => setYoutubeUrl(e.target.value)}
        />
        <div style={{ marginTop: 12 }}>
          <button
            style={loading === "analyze" || !youtubeUrl ? buttonDisabled : buttonStyle}
            disabled={loading === "analyze" || !youtubeUrl}
            onClick={handleAnalyze}
          >
            {loading === "analyze"
              ? "Fetching metadata… (usually 15–60s)"
              : "Analyze video"}
          </button>
        </div>

        {/* …or skip the URL entirely and upload a local video file */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "18px 0 12px" }}>
          <div style={{ flex: 1, height: 1, background: BORDER }} />
          <span style={{ fontSize: 12, color: "#8A8D93", whiteSpace: "nowrap" }}>
            or upload a video from your computer
          </span>
          <div style={{ flex: 1, height: 1, background: BORDER }} />
        </div>
        <input
          type="file"
          accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi,.mpg,.mpeg,.flv,.ts"
          style={{ ...inputStyle, padding: 10 }}
          onChange={(e) => setSourceFile(e.target.files?.[0] ?? null)}
        />
        {sourceFile && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#8A8D93" }}>
            Selected: {sourceFile.name} ({(sourceFile.size / 1000000).toFixed(1)} MB)
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <button
            style={loading === "upload" || !sourceFile ? buttonDisabled : buttonStyle}
            disabled={loading === "upload" || !sourceFile}
            onClick={handleUpload}
          >
            {loading === "upload"
              ? "Uploading & analyzing… (depends on file size)"
              : "Analyze uploaded video"}
          </button>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 12, color: "#8A8D93" }}>
          Uploaded files usually have no captions, so the AI picks the strongest
          moments visually (ffmpeg scene-cut analysis + the vision model) instead
          of from spoken lines.
        </p>
        {intel && (
          <div style={{ marginTop: 12, fontSize: 13, color: "#8A8D93" }}>
            Loaded "{intel.title}" — {Math.round(intel.durationSec)}s, {intel.transcript.length} transcript words.
            {filePending && (
              <div style={{ marginTop: 6, fontSize: 12, color: "#8A8D93" }}>
                ✔ Metadata loaded. The video file downloads automatically when you
                render a clip (first render for a video takes a few extra minutes
                because of the download; after that it's cached).
              </div>
            )}
          </div>
        )}
      </section>

      {/* Step 2: optional style sample — upload a reference clip (no Apify) */}
      <section style={stepStyle}>
        <span style={labelStyle}>02 · Reference editing style (optional)</span>
        <p style={{ fontSize: 13, color: "#8A8D93", margin: "0 0 12px" }}>
          Upload a short clip whose editing style you want copied. Frames are read
          locally with ffmpeg and analyzed by the vision model — no Apify, no URL.
        </p>
        <input
          type="file"
          accept="video/*"
          style={{ ...inputStyle, padding: 10 }}
          onChange={(e) => setSampleFile(e.target.files?.[0] ?? null)}
        />
        {sampleFile && (
          <div style={{ marginTop: 8, fontSize: 13, color: "#8A8D93" }}>
            Selected: {sampleFile.name} ({(sampleFile.size / 1000000).toFixed(1)} MB)
          </div>
        )}
        <div style={{ marginTop: 12 }}>
          <button
            style={loading === "style" || !sampleFile ? buttonDisabled : buttonStyle}
            disabled={loading === "style" || !sampleFile}
            onClick={handleStyleProfile}
          >
            {loading === "style" ? "Analyzing style…" : "Extract style profile"}
          </button>
        </div>
        {styleProfile && (
          <div style={{ marginTop: 12, fontSize: 13, color: "#8A8D93" }}>
            Cut ~every {styleProfile.avgCutLengthSec}s · captions {styleProfile.captionStyle.wordsPerCaption}{" "}
            words/{styleProfile.captionStyle.position} · zoom every {styleProfile.zoomRhythm.zoomEverySec}s
          </div>
        )}
      </section>

      {/* Step 3: rules — editable every run */}
      <section style={stepStyle}>
        <span style={labelStyle}>03 · Editing rules (change these anytime)</span>
        <textarea
          style={{ ...inputStyle, minHeight: 80, resize: "vertical" }}
          value={rulesText}
          onChange={(e) => setRulesText(e.target.value)}
        />
        <div style={{ marginTop: 10 }}>
          <button
            style={{
              ...buttonStyle,
              background: "transparent",
              color: "#8A8D93",
              border: `1px solid ${BORDER}`,
              padding: "6px 12px",
              fontSize: 12,
            }}
            onClick={() => setShowSystemPrompt((v) => !v)}
          >
            {showSystemPrompt ? "Hide AI system prompt" : "Edit AI system prompt (advanced)"}
          </button>
        </div>
        {showSystemPrompt && (
          <div style={{ marginTop: 10 }}>
            <span style={labelStyle}>
              AI system prompt — how the model picks moments &amp; writes captions (saved
              automatically when you generate)
            </span>
            <textarea
              style={{
                ...inputStyle,
                minHeight: 170,
                resize: "vertical",
                fontFamily: "monospace",
                fontSize: 12,
              }}
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
            <button
              style={{
                ...buttonStyle,
                background: "transparent",
                color: "#8A8D93",
                border: `1px solid ${BORDER}`,
                padding: "6px 12px",
                fontSize: 12,
                marginTop: 8,
              }}
              onClick={resetSystemPrompt}
            >
              Reset to default
            </button>
          </div>
        )}
        <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
          <div style={{ flex: 1 }}>
            <span style={labelStyle}># Clips</span>
            <input
              type="number"
              style={inputStyle}
              value={targetClipCount}
              onChange={(e) => setTargetClipCount(Number(e.target.value))}
            />
          </div>
          <div style={{ flex: 1 }}>
            <span style={labelStyle}>Min sec</span>
            <input type="number" style={inputStyle} value={minSec} onChange={(e) => setMinSec(Number(e.target.value))} />
          </div>
          <div style={{ flex: 1 }}>
            <span style={labelStyle}>Max sec</span>
            <input type="number" style={inputStyle} value={maxSec} onChange={(e) => setMaxSec(Number(e.target.value))} />
          </div>
        </div>
        {intel && intel.transcript?.length === 0 && (
          <p style={{ margin: "12px 0 0", fontSize: 12, color: "#8A8D93" }}>
            Uploaded videos have no transcript, so your free-text rules steer the&nbsp;AI&apos;s
            visual analysis (what counts as an interesting moment) and the clip count /
            length bounds below. Rules that quote spoken lines can&apos;t match — there are no
            words to match yet.
          </p>
        )}
        <div style={{ marginTop: 12 }}>
          <button
            style={loading === "plan" || !intel ? buttonDisabled : buttonStyle}
            disabled={loading === "plan" || !intel}
            onClick={handleGeneratePlan}
          >
            {loading === "plan"
              ? "Analyzing video + planning… (1–4 min, don't close)"
              : "Generate edit plan"}
          </button>
          {!filePending && intel && (
            <p style={{ margin: "8px 0 0", fontSize: 12, color: "#8A8D93" }}>
              Uploaded videos have no transcript, so the first step scans the
              whole file visually (scene cuts + vision model) — this can take a
              few minutes for long videos. Your earlier request hit a timeout at
              exactly 2 minutes and got aborted; it now waits up to 5 minutes.
            </p>
          )}
        </div>
      </section>

      {/* Watch-before-post: clips already rendered on this machine */}
      {existingRenders.length > 0 && (
        <section style={stepStyle}>
          <span style={labelStyle}>Rendered clips on this machine — watch before posting</span>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 12 }}>
            {existingRenders.map((r) => (
              <div key={r.file}>
                <video
                  src={r.url}
                  controls
                  preload="metadata"
                  style={{ display: "block", width: 220, borderRadius: 8 }}
                />
                <div style={{ fontSize: 12, color: "#8A8D93", marginTop: 6 }}>
                  {r.hookTitle || r.file} · {r.sizeMb} MB
                </div>
                <button
                  style={
                    loading === `del-render-${r.file}` ? dangerButtonDisabled : dangerButton
                  }
                  disabled={loading === `del-render-${r.file}`}
                  onClick={() => handleDeleteRender(r.file)}
                  title="Delete this rendered clip from this machine"
                >
                  {loading === `del-render-${r.file}` ? "Deleting…" : "Delete"}
                </button>
              </div>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "#8A8D93", marginBottom: 0 }}>
            Preview only — nothing is uploaded anywhere from this section. Posting happens
            only through the “Post via Buffer” controls, which stay locked until a clip is
            rendered for the current video.
          </p>
        </section>
      )}

      {/* Storage management: source videos cached on this machine */}
      {storedUploads.length > 0 && (
        <section style={stepStyle}>
          <span style={labelStyle}>Source videos stored on this machine</span>
          <p style={{ fontSize: 13, color: "#8A8D93", margin: "0 0 12px" }}>
            Every video file the pipeline saved while you worked — URL downloads and your
            own uploads. Deleting removes only the local copy; anything already queued in
            Buffer stays live. The video currently loaded in Step 01 is protected.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {storedUploads.map((u) => {
              const inUse = currentUploadFile() === u.file;
              return (
                <div
                  key={u.file}
                  style={{ display: "flex", alignItems: "center", gap: 12 }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      color: "#E8E6E1",
                      flex: 1,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {u.file}{" "}
                    <span style={{ color: "#8A8D93" }}>
                      · {u.sizeMb} MB · {new Date(u.modified).toLocaleString()}
                      {inUse ? " · in use right now" : ""}
                    </span>
                  </span>
                  <button
                    style={{
                      ...buttonStyle,
                      padding: "6px 14px",
                      fontSize: 12,
                      background: "#2A2D31",
                      color: "#E8E6E1",
                    }}
                    disabled={loading === `load-${u.file}`}
                    onClick={() => handleLoadUpload(u.file)}
                    title="Load this stored video back into Step 01 without re-uploading (avoids duplicate copies)"
                  >
                    {loading === `load-${u.file}` ? "Loading…" : "Load"}
                  </button>
                  <button
                    style={
                      inUse || loading === `del-upload-${u.file}`
                        ? dangerButtonDisabled
                        : dangerButton
                    }
                    disabled={inUse || loading === `del-upload-${u.file}`}
                    onClick={() => handleDeleteUpload(u.file)}
                    title={
                      inUse
                        ? "This video is loaded in Step 01 — analyze a different video first"
                        : "Delete this stored video from this machine"
                    }
                  >
                    {loading === `del-upload-${u.file}`
                      ? "Deleting…"
                      : inUse
                        ? "In use"
                        : "Delete"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Step 4: clips + render */}
      {editPlan && (
        <section style={stepStyle}>
          <span style={labelStyle}>04 · Clips</span>
          {editPlan.clips.map((clip, i) => (
            <div
              key={clip.clipId}
              style={{ borderTop: i === 0 ? "none" : `1px solid ${BORDER}`, padding: "16px 0" }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{clip.hookTitle}</div>
              <div style={{ fontSize: 13, color: "#8A8D93", marginBottom: 10 }}>
                {clip.sourceStartSec.toFixed(1)}s → {clip.sourceEndSec.toFixed(1)}s ·{" "}
                {editedDurationSec(clip).toFixed(1)}s clip{clip.segments?.length ? " (tightened)" : ""}
              </div>
              <button
                style={loading === `render-${i}` ? buttonDisabled : buttonStyle}
                disabled={loading === `render-${i}`}
                onClick={() => handleRender(i)}
              >
                {loading === `render-${i}`
                  ? (filePending
                      ? "Downloading source + rendering… (3–8 min, don't close)"
                      : "Rendering… (1–4 min, don't close)")
                  : "Render clip"}
              </button>
              {!renderedUrls[i] && (
                <p style={{ margin: "8px 0 0", fontSize: 12, color: "#8A8D93" }}>
                  Click Render clip and wait for it to finish — the video player, the
                  “Post via Buffer” section and the “Tell the AI what to post” box all
                  appear right here once the clip is rendered. (First render downloads
                  the source if needed and runs the whole Remotion pass.)
                </p>
              )}
              {renderedUrls[i] && (
                <>
                  <video
                    src={renderedUrls[i]}
                    controls
                    style={{ display: "block", marginTop: 12, width: 220, borderRadius: 8 }}
                  />

                  <div style={{ marginTop: 16, borderTop: `1px solid ${BORDER}`, paddingTop: 16 }}>
                    <span style={labelStyle}>Post via Buffer · pick any channels across accounts</span>

                    {accountChannels.length === 0 ? (
                      <p style={{ fontSize: 13, color: "#8A8D93", margin: "0 0 10px" }}>
                        No Buffer accounts configured — add one in the “Buffer accounts” panel above.
                      </p>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 12 }}>
                        {accountChannels.map(({ account, channels: accChannels, error: chErr }) => (
                          <div key={account.id}>
                            <div style={{ fontSize: 11, letterSpacing: 1, textTransform: "uppercase", color: "#8A8D93", marginBottom: 6 }}>
                              {account.name}
                              {chErr ? ` · ${chErr}` : ""}
                            </div>
                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              {accChannels.length === 0 && !chErr && (
                                <span style={{ fontSize: 12, color: "#8A8D93" }}>No channels connected.</span>
                              )}
                              {accChannels.map((c) => {
                                const key = `${account.id}:${c.id}`;
                                const checked = selectedTargets[i]?.[key] ?? false;
                                return (
                                  <label key={key} style={chipStyle(checked)}>
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => toggleTarget(i, key)}
                                      style={{ marginRight: 6, accentColor: ACCENT }}
                                    />
                                    {c.displayName} ({c.service})
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    <div
                      style={{
                        marginBottom: 10,
                        padding: "10px 12px",
                        border: `1px dashed ${ACCENT}`,
                        borderRadius: 6,
                        background: "#1A120B",
                      }}
                    >
                      <div style={{ fontSize: 12, color: "#FF9B7A", fontWeight: 700, marginBottom: 6 }}>
                        Tell the AI what to post
                      </div>
                      <input
                        style={inputStyle}
                        placeholder={
                          'e.g. "Home-gym workout for beginners — fun, energetic, ' +
                            'ask people to comment their favorite move, use 3 hashtags"'
                        }
                        value={postBrief[i] ?? ""}
                        onChange={(e) =>
                          setPostBrief((prev) => ({ ...prev, [i]: e.target.value }))
                        }
                      />
                      <button
                        style={
                          loading === `draft-${i}` || !(postBrief[i] ?? "").trim()
                            ? buttonDisabled
                            : buttonStyle
                        }
                        disabled={loading === `draft-${i}` || !(postBrief[i] ?? "").trim()}
                        onClick={() => handleDraftCaption(i)}
                      >
                        {loading === `draft-${i}`
                          ? "Drafting with AI… (up to 3 min)"
                          : "✏ Draft caption with AI"}
                      </button>
                    </div>

                    <textarea
                      style={{ ...inputStyle, minHeight: 60, resize: "vertical", marginBottom: 10 }}
                      placeholder="Caption (applied to all selected channels unless overridden per target later)"
                      value={caption[i] ?? ""}
                      onChange={(e) => setCaption((prev) => ({ ...prev, [i]: e.target.value }))}
                    />

                    <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
                      <select
                        style={inputStyle}
                        value={postMode[i] ?? "queue"}
                        onChange={(e) =>
                          setPostMode((prev) => ({ ...prev, [i]: e.target.value as "queue" | "schedule" }))
                        }
                      >
                        <option value="queue">Add to queue (next open slot)</option>
                        <option value="schedule">Schedule for a specific time</option>
                      </select>
                      {postMode[i] === "schedule" && (
                        <input
                          type="datetime-local"
                          style={inputStyle}
                          value={dueAt[i] ?? ""}
                          onChange={(e) => setDueAt((prev) => ({ ...prev, [i]: e.target.value }))}
                        />
                      )}
                    </div>

                    <button
                      style={
                        loading === `post-${i}` || renderedUrls[i] === undefined || selectedCount(i) === 0
                          ? buttonDisabled
                          : buttonStyle
                      }
                      disabled={loading === `post-${i}` || selectedCount(i) === 0}
                      onClick={() => handlePostToBuffer(i)}
                    >
                      {loading === `post-${i}`
                        ? "Posting everywhere…"
                        : `Post to ${selectedCount(i)} channel${selectedCount(i) === 1 ? "" : "s"} simultaneously`}
                    </button>
                    {postResult[i] && (
                      <span style={{ marginLeft: 12, fontSize: 13, color: "#8A8D93" }}>{postResult[i]}</span>
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </section>
      )}

      {/* Caption coach — Apify web research + GLM rewriting per platform */}
      {editPlan && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span style={labelStyle}>Apply coached captions to</span>
            <select
              style={{ ...inputStyle, width: 200 }}
              value={coachTargetClip}
              onChange={(e) => setCoachTargetClip(Number(e.target.value))}
            >
              {editPlan.clips.map((_, idx) => (
                <option key={idx} value={idx}>
                  Clip #{idx + 1}
                </option>
              ))}
            </select>
          </div>
          <CaptionCoach
            platforms={coachPlatforms(coachTargetClip)}
            draftCaption={caption[coachTargetClip] ?? ""}
            onApplyCaption={(c) => setCaption((prev) => ({ ...prev, [coachTargetClip]: c }))}
          />
        </>
      )}

      {/* Per-account Buffer analytics + AI growth advice */}
      <AnalyticsPanel accounts={savedAccounts} />

      {/* Floating chat assistant — propose-only until you Confirm */}
      <ChatPanel />
    </main>
  );
}
