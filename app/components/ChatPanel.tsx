"use client";

// Floating chat assistant — now the full-page copilot.
//
// The model sees a live snapshot of the page (what video is loaded, the edit
// plan, rendered clips, Buffer channels) and can propose actions for EVERY
// page feature. Safe/quick actions run automatically and the page updates
// live; expensive or irreversible ones (render, post, delete) wait for one
// Confirm click. After each step the conversation continues by itself until
// the user's request is done.

import React, { useEffect, useRef, useState } from "react";

const ACCENT = "#FF5A1F";
const PANEL = "#15171A";
const BORDER = "#2A2D31";
const MAX_STEPS = 8; // hard cap on auto-steps per user turn

interface Msg {
  role: "user" | "assistant";
  content: string;
}

/** Long-running actions get a bigger client timeout; everything else is quick. */
function timeoutFor(action: any): number {
  switch (action?.action) {
    case "render_clip":
    case "schedule_run_now": // may run a render (or any heavy action) internally
      return 660_000; // download + Remotion can take minutes
    case "post_to_buffer":
    case "generate_edit_plan":
    case "analyze_url":
      return 300_000;
    default:
      return 300_000;
  }
}

/** Short replies that mean "execute the plan you just showed me". */
function isPlanApproval(text: string): boolean {
  const t = text.trim();
  if (t.length > 60) return false;
  return /^(y(es|eah|ep|a)?|yup|sure|ok(ay)?|go( ahead)?|do it|proceed|execute|approve(d)?|start( it)?|run it|continue|looks good|sounds good|good to go|perfect|lfg|send it)\b/i.test(
    t
  );
}

/** Chrome aborts fetches with a bare DOMException whose message is the cryptic
 *  "signal is aborted without reason". Translate that (and only that) into a
 *  sentence a human can act on. */
function friendlyAbortError(waitedSec: number): Error {
  return new Error(
    `This step was canceled after ${Math.round(waitedSec / 1000)}s — the AI service ` +
      "is unusually slow right now (a temporary network phase; it passes). " +
      "Send your message again in a moment. Scheduled automations keep running " +
      "in the background regardless."
  );
}

/** Formats a legacy chat result (post/repurpose) for display. */
function fmtResult(r: any): string {
  if (r?.kind === "post") {
    const lines = (r.results ?? []).map((x: any) =>
      x.ok
        ? `✅ ${x.channel ?? x.channelId} — queued (post ${x.postId ?? "?"})`
        : `❌ ${x.channel ?? x.channelId} — ${x.error}`
    );
    const ok = r.results?.filter((x: any) => x.ok).length ?? 0;
    return `Posted to ${ok}/${r.results?.length ?? 0} channels:\n${lines.join("\n")}`;
  }
  if (r?.kind === "repurpose") {
    const src = `Fetched from ${r.source.platform} (${r.source.via})`;
    const drafts = (r.drafts ?? [])
      .map((d: any) => `--- ${d.platform} ---\n${d.text}`)
      .join("\n\n");
    return `${src}. Rewritten drafts — tell me "post the twitter one to ..." to publish any of them:\n\n${drafts}`;
  }
  return JSON.stringify(r, null, 2);
}

interface ChatPanelProps {
  /** Full page state (intel, rules, editPlan, renderedUrls, channels…) for enrichment. */
  pageState?: any;
  /** Light summary of the page sent to the model with each message. */
  promptContext?: any;
  /** Applies a server state patch to the page's React state. */
  onStatePatch?: (patch: any) => void;
}

export default function ChatPanel({ pageState, promptContext, onStatePatch }: ChatPanelProps) {
  const [open, setOpen] = useState(false);
  // Auto-pilot (default ON): every proposed action — including
  // post_to_buffer — runs immediately instead of waiting for a Confirm click,
  // so the copilot can edit and publish on its own. Persisted per browser.
  const [autoRun, setAutoRun] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.localStorage.getItem("l2sChatAutoRun") !== "0"
  );
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<any | null>(null);
  const [executing, setExecuting] = useState(false);
  const stepsRef = useRef(0);
  // Plan-first gate: cleared only when the user approves (Approve card or a
  // typed "go"). Until then NO action executes — a hard backstop on top of the
  // prompt's PLAN FIRST rule, so the AI can never jump straight to implementing.
  const planOkRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Props are recreated on every parent render but the agent loop runs across
  // awaits — hold the latest values in refs so a step always reads the freshest
  // page state (e.g. right after analyze_loaded an intel, or render filled a URL).
  const stateRef = useRef<any>(pageState);
  stateRef.current = pageState;
  const ctxRef = useRef<any>(promptContext);
  ctxRef.current = promptContext;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 10_000_000 });
  }, [messages, pending, open, executing]);

  useEffect(() => {
    try {
      window.localStorage.setItem("l2sChatAutoRun", autoRun ? "1" : "0");
    } catch {
      /* private mode — ignore */
    }
  }, [autoRun]);
// ---------- helpers ----------

  function serviceForKey(matchChannelId: string): string {
    const accounts = stateRef.current?.accountChannels ?? [];
    for (const a of accounts) {
      const c = (a.channels ?? []).find((x: any) => x.id === matchChannelId);
      if (c) return c.service ?? "";
    }
    return "";
  }

  /** Platform names mapped from the connected channels (fallback list). */
  function defaultPlatforms(): string[] {
    const services = (stateRef.current?.accountChannels ?? []).flatMap((a: any) =>
      (a.channels ?? []).map((c: any) => String(c.service ?? "").toLowerCase())
    );
    const out: string[] = [];
    for (const s of services) {
      if (s.includes("tiktok") && !out.includes("tiktok")) out.push("tiktok");
      if (s.includes("instagram") && !out.includes("instagram")) out.push("instagram");
      if (s.includes("youtube") && !out.includes("youtube")) out.push("youtube");
    }
    if (!out.length) return ["tiktok", "instagram", "youtube"];
    return out;
  }

  /** Fills in live page data (intel/editPlan/renderedPath/targets…) the model
   *  can't know about, mirroring exactly what the page buttons send. */
  function enrichAction(action: any): any {
    const s = stateRef.current ?? {};
    switch (action?.action) {
      case "generate_edit_plan": {
        const base = s.rules ?? { instructions: "", targetClipCount: 3, minClipSec: 20, maxClipSec: 60 };
        const rules = {
          ...base,
          instructions: action.instructions ?? base.instructions ?? "",
          targetClipCount: Number(action.clipCount ?? action.targetClipCount ?? base.targetClipCount) || 3,
          minClipSec: Number(action.minSec ?? action.minClipSec ?? base.minClipSec) || 20,
          maxClipSec: Number(action.maxSec ?? action.maxClipSec ?? base.maxClipSec) || 60,
          aspect: "9:16" as const,
        };
        return {
          ...action,
          intel: s.intel,
          rules,
          styleProfile: s.styleProfile ?? undefined,
          targetPlatforms:
            Array.isArray(action.targetPlatforms) && action.targetPlatforms.length
              ? action.targetPlatforms
              : (base.targetPlatforms ?? ["tiktok", "instagram_reels", "youtube_shorts"]),
          systemPrompt: s.systemPrompt ?? "",
        };
      }
      case "render_clip":
        return { ...action, editPlan: s.editPlan, sourceUrl: s.intel?.sourceUrl ?? "" };
      case "post_to_buffer": {
        const clipIndex = Number(action.clipIndex ?? 0);
        const renderedPath = s.renderedUrls?.[clipIndex] ?? null;
        const targets = (Array.isArray(action.channels) ? action.channels : [])
          .map((key: string) => {
            const i = String(key).indexOf(":");
            return {
              accountId: String(key).slice(0, i),
              channelId: String(key).slice(i + 1),
              service: serviceForKey(String(key).slice(i + 1)),
              postType:
                action.postType === "story" || action.postType === "reel"
                  ? action.postType
                  : undefined,
            };
          })
          .filter((t: any) => t.accountId && t.channelId);
        return {
          ...action,
          clipIndex,
          renderedPath,
          targets,
          caption: action.caption ?? s.captions?.[clipIndex] ?? "",
          mode: action.mode ?? "queue",
          dueAtIso: action.dueAtIso || undefined,
        };
      }
      case "draft_caption": {
        const clipIndex = Number(action.clipIndex ?? 0);
        const hook = s.editPlan?.clips?.[clipIndex]?.hookTitle;
        const topic = String(action.brief ?? hook ?? `Clip ${clipIndex}`).trim();
        return {
          ...action,
          clipIndex,
          brief: topic,
          draftCaption: s.captions?.[clipIndex] ?? "",
          platforms:
            Array.isArray(action.platforms) && action.platforms.length
              ? action.platforms
              : defaultPlatforms(),
        };
      }
      case "story_cut":
        if (!action.renderedPath && action.clipIndex != null) {
          return { ...action, renderedPath: s.renderedUrls?.[Number(action.clipIndex)] };
        }
        return action;
      default:
        return action;
    }
  }
async function callChat(msgs: Msg[]) {
    // A single model call can legitimately take minutes on the NVIDIA endpoint
    // (measured up to ~5min on this network during multi-step turns). The old
    // 210s cap aborted mid-generation and Chrome surfaced the raw DOMException
    // text "signal is aborted without reason" in the chat. 10 min covers the
    // worst observed generation with headroom (the server itself caps at 5min).
    const timeoutMs = 600_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: msgs, context: ctxRef.current ?? null }),
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      return j;
    } catch (e: any) {
      if (e?.name === "AbortError") throw friendlyAbortError(timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function callExecute(action: any) {
    const timeoutMs = timeoutFor(action);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch("/api/chat/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: enrichAction(action) }),
        signal: ctrl.signal,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (j.statePatch) onStatePatch?.(j.statePatch);
      return j;
    } catch (e: any) {
      if (e?.name === "AbortError") throw friendlyAbortError(timeoutMs);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- orchestration ----------

  /** Runs one step: executes the action, applies its patch, feeds the result
   *  back to the model as a ⚙ step-complete marker. */
  async function runStep(msgs: Msg[], action: any): Promise<Msg[]> {
    const j = await callExecute(action);
    const label = j.label ?? action.action ?? "step";
    const summary = j.summary ?? JSON.stringify(j.result ?? {}).slice(0, 200);
    const marker: Msg = {
      role: "user",
      content: `⚙ Step complete — ${label}: ${summary}`,
    };
    return [...msgs, marker];
  }

  /** Agent loop: chat → act → feed back → repeat, until the model is done or
   *  the user must Confirm something (render/post/delete). */
  async function drive(msgs: Msg[]) {
    stepsRef.current = 0;
    setBusy(true);
    try {
      for (;;) {
        if (stepsRef.current >= MAX_STEPS) {
          setMessages((m) => [
            ...m,
            {
              role: "assistant",
              content:
                "I've hit the safety cap for steps in one turn. Say “continue” and I'll keep going.",
            },
          ]);
          return;
        }
        const j = await callChat(msgs);
        setMessages(msgs.concat({ role: "assistant", content: j.reply }));
        if (!j.pendingAction) return; // the model is done for this turn
        const action = j.pendingAction;
        // PLAN FIRST: block until the user approves (Approve card or typed
        // approval) — the assistant must show its plan before anything runs.
        if (!planOkRef.current) {
          setPending({ ...action, planCard: true });
          return;
        }
        if (action.needsConfirm && !autoRun) {
          setPending(action); // stop and wait for the user's click
          return;
        }
        // autoRun ON: even confirm-worthy actions (render/post/delete) run
        // right away — the ⚙ marker below shows what actually happened.
        msgs = await runStep(msgs, action);
        stepsRef.current += 1;
      }
    } catch (err: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `⚠️ ${err.message ?? "chat failed"}` },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    // A short approval ("go", "ok", "yes"…) executes the plan the assistant
    // just showed; anything else starts a NEW plan cycle (gate closed again).
    planOkRef.current = isPlanApproval(text);
    await drive([...messages, { role: "user", content: text }]);
  }

  /** Confirm button handler — runs the pending action, then keeps the pipeline
   *  going automatically (e.g. render → then propose posting). */
  async function confirmAction() {
    if (!pending || executing) return;
    planOkRef.current = true; // confirming/approving = approval to proceed
    setExecuting(true);
    try {
      const j = await callExecute(pending);
      const label = j.label ?? pending.action ?? "step";
      const summary = j.summary ?? JSON.stringify(j.result ?? {}).slice(0, 200);
      const marker: Msg = {
        role: "user",
        content: `⚙ Step complete — ${label}: ${summary}`,
      };
      const next = [...messages, { role: "assistant" as const, content: `✔ Done — ${label}.` }, marker];
      setPending(null);
      setMessages(next);
      await drive(next);
    } catch (err: any) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `⚠️ ${err.message ?? "action failed"}` },
      ]);
    } finally {
      setExecuting(false);
    }
  }

  function cancelAction() {
    setPending(null);
  }
if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          position: "fixed",
          right: 24,
          bottom: 24,
          zIndex: 60,
          background: ACCENT,
          color: "#fff",
          border: "none",
          borderRadius: 999,
          padding: "14px 22px",
          fontWeight: 700,
          cursor: "pointer",
          boxShadow: "0 6px 24px rgba(0,0,0,.45)",
          fontSize: 15,
        }}
      >
        💬 Copilot
      </button>
    );
  }

  const summaryOfAction = (a: any) => {
    if (!a) return "";
    switch (a.action) {
      case "render_clip":
        return `Render Clip ${a.clipIndex ?? 0} (from the current edit plan) into an mp4.`;
      case "post_to_buffer":
        return `Post Clip ${a.clipIndex ?? 0} to ${(a.channels ?? []).length} channel(s). Caption: "${a.caption ?? ""}".`;
      case "delete_render":
        return `Delete rendered clip "${a.file}" from disk.`;
      case "delete_upload":
        return `Delete stored video "${a.file}" from disk.`;
      default:
        return JSON.stringify(a).slice(0, 200);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        right: 24,
        bottom: 24,
        zIndex: 60,
        width: 400,
        maxWidth: "calc(100vw - 32px)",
        height: "min(640px, 82vh)",
        background: PANEL,
        border: `1px solid ${BORDER}`,
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        boxShadow: "0 10px 40px rgba(0,0,0,.55)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px",
          borderBottom: `1px solid ${BORDER}`,
          fontWeight: 700,
          color: "#e6e8ea",
        }}
      >
        <span>💬 Copilot — drives the whole page</span>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <label
            title="When on, every action (including posting to your channels) runs immediately — no Confirm click needed."
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              fontWeight: 400,
              color: autoRun ? ACCENT : "#9aa0a6",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={autoRun}
              onChange={(e) => setAutoRun(e.target.checked)}
              style={{ accentColor: ACCENT, cursor: "pointer" }}
            />
            Auto-run
          </label>
          <button
            onClick={() => setOpen(false)}
            style={{ background: "none", border: "none", color: "#9aa0a6", cursor: "pointer", fontSize: 18 }}
            aria-label="Close chat"
          >
            ✕
          </button>
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: 14 }}>
        {messages.length === 0 && (
          <div style={{ color: "#8b9096", fontSize: 14, lineHeight: 1.7 }}>
            I can drive the whole page — just ask:
            <br />• “Analyze this video and make me 3 shorts: &lt;url&gt;”
            <br />• “Generate the edit plan, then render clip 0”
            <br />• “Draft a caption for clip 1”
            <br />• “Post the rendered clip 0 to my TikTok”
            <br />• “What are trending sounds for fitness?”
            <br />• “Build a viral pack for AI tips”
          </div>
        )}

        {messages.map((m, i) => {
          const isStep = m.role === "user" && m.content.startsWith("⚙ ");
          return (
            <div
              key={i}
              style={{
                margin: "8px 0",
                background: isStep ? "#141c26" : m.role === "user" ? ACCENT : "#1d2024",
                color: isStep ? "#8fc0ff" : m.role === "user" ? "#fff" : "#e6e8ea",
                padding: "9px 12px",
                borderRadius: 10,
                whiteSpace: "pre-wrap",
                fontSize: isStep ? 12.5 : 14,
                lineHeight: 1.5,
                maxWidth: "92%",
                marginLeft: m.role === "user" ? "auto" : 0,
              }}
            >
              {m.content}
            </div>
          );
        })}

        {busy && (
          <div style={{ color: "#8b9096", fontSize: 13, padding: "6px 2px" }}>thinking / working…</div>
        )}

        {pending && (
          <div
            style={{
              marginTop: 10,
              border: `1px solid ${ACCENT}`,
              borderRadius: 10,
              padding: 12,
              fontSize: 13,
              color: "#e6e8ea",
            }}
          >
            <b style={{ color: ACCENT }}>
              {pending.planCard ? "Approve plan — start" : `Confirm ${pending.actionLabel ?? pending.action}`}
            </b>
            <div style={{ margin: "6px 0", fontSize: 12.5, color: "#c9ced4" }}>
              {summaryOfAction(pending)}
            </div>
            <pre
              style={{
                margin: "8px 0",
                whiteSpace: "pre-wrap",
                fontSize: 11.5,
                color: "#9aa0a6",
                maxHeight: 130,
                overflowY: "auto",
              }}
            >
              {JSON.stringify(pending, null, 2)}
            </pre>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={confirmAction}
                disabled={executing}
                style={{
                  background: ACCENT,
                  color: "#fff",
                  border: "none",
                  borderRadius: 8,
                  padding: "7px 14px",
                  fontWeight: 700,
                  cursor: executing ? "wait" : "pointer",
                }}
              >
                {executing ? "Running…" : "Confirm"}
              </button>
              <button
                onClick={cancelAction}
                disabled={executing}
                style={{
                  background: "transparent",
                  color: "#9aa0a6",
                  border: `1px solid ${BORDER}`,
                  borderRadius: 8,
                  padding: "7px 14px",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
<div style={{ display: "flex", gap: 8, padding: 12, borderTop: `1px solid ${BORDER}` }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Tell me what to do — e.g. make me 3 shorts from a video"
          style={{
            flex: 1,
            background: "#0f1113",
            border: `1px solid ${BORDER}`,
            borderRadius: 8,
            color: "#e6e8ea",
            padding: "10px 12px",
            fontSize: 14,
            outline: "none",
          }}
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          style={{
            background: ACCENT,
            color: "#fff",
            border: "none",
            borderRadius: 8,
            padding: "10px 16px",
            fontWeight: 700,
            cursor: busy ? "wait" : "pointer",
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}