// lib/colorGrade.ts — the color-grading + visual-effects engine.
//
// ONE spec drives the whole "look" pipeline: the edit planner (or the chat's
// apply_grade / add_effect actions) writes a GradeSpec / ClipEffect[] onto a
// ClipPlan, and the Remotion composition (remotion/ShortClip.tsx) turns it
// into CSS filters + overlay layers at render time — no After Effects, no
// ffmpeg filter graph, works identically on your PC and on Railway.
//
// Every export here is a PURE function so it is safe to import from client
// components, server actions and the plan normalizer alike.

import type { ClipEffect, GradeSpec } from "./types";

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const num = (v: unknown, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Named looks the planner / chat can reference. Each value is a complete
 *  GradeSpec; any field the caller passes on top wins over the preset. */
export const GRADE_PRESETS: Record<string, GradeSpec> = {
  cinematic: { contrast: 0.28, saturation: 0.12, warmth: 0.18, vignette: 0.35, brightness: -0.02, grain: 0.08 },
  golden: { warmth: 0.6, brightness: 0.05, saturation: 0.15, contrast: 0.12, vignette: 0.2 },
  moody: { brightness: -0.12, contrast: 0.3, saturation: -0.2, warmth: -0.08, vignette: 0.5, grain: 0.15 },
  punchy: { contrast: 0.4, saturation: 0.35, vignette: 0.15, brightness: 0.02 },
  vibrant: { saturation: 0.5, contrast: 0.15, brightness: 0.03 },
  vintage: { warmth: 0.3, saturation: -0.25, contrast: -0.08, brightness: 0.06, vignette: 0.4, grain: 0.45 },
  noir: { saturation: -1, contrast: 0.5, brightness: -0.03, vignette: 0.55, grain: 0.3 },
  cold: { warmth: -0.55, saturation: -0.05, contrast: 0.15, vignette: 0.25 },
};

export const EFFECT_TYPES = ["shake", "flash", "lightLeak"] as const;

/** Default lengths per effect type (seconds) when the caller omits durSec. */
const DEFAULT_DUR: Record<ClipEffect["type"], number> = {
  flash: 0.3,
  shake: 0.8,
  lightLeak: 2,
};

/** Hard cap so a model can never stack hundreds of layers into the render. */
const MAX_EFFECTS_PER_CLIP = 8;

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

// ---------------------------------------------------------------------------
// Sanitizers — turn untrusted (LLM / chat) JSON into clamped, safe specs.
// ---------------------------------------------------------------------------

/** Validates a GradeSpec from the model. Returns undefined when there is
 *  nothing usable (unknown preset with no numeric fields, wrong types…). */
export function sanitizeGrade(raw: unknown): GradeSpec | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const g: GradeSpec = {};

  if (typeof r.preset === "string") {
    const p = r.preset.trim().toLowerCase();
    // "none" = deliberately ungraded; unknown names are dropped (the presets
    // are a closed list so a hallucinated look can't leak into the render).
    if (p && p !== "none" && Object.prototype.hasOwnProperty.call(GRADE_PRESETS, p)) {
      g.preset = p;
    }
  }

  const field = (
    key: "intensity" | "brightness" | "contrast" | "saturation" | "warmth" | "vignette" | "grain",
    lo: number,
    hi: number
  ) => {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) g[key] = clamp(v, lo, hi);
  };
  field("intensity", 0, 1);
  field("brightness", -0.5, 0.5);
  field("contrast", -0.5, 1);
  field("saturation", -1, 1);
  field("warmth", -1, 1);
  field("vignette", 0, 1);
  field("grain", 0, 1);

  return Object.keys(g).length ? g : undefined;
}

/** Validates an effects array. Keeps every well-formed entry (max 8), drops
 *  the rest. `clipDurSec` (when known) drops effects that start past the end
 *  of the clip and clamps ones that would overrun it. */
export function sanitizeEffects(raw: unknown, clipDurSec?: number): ClipEffect[] {
  if (!Array.isArray(raw)) return [];
  const out: ClipEffect[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const r = item as Record<string, unknown>;
    const type = String(r.type ?? "").trim();
    if (!(EFFECT_TYPES as readonly string[]).includes(type)) continue;
    const t = type as ClipEffect["type"];

    const dur = clamp(num(r.durSec, DEFAULT_DUR[t]), 0.05, 30);
    let atSec = clamp(num(r.atSec, 0), 0, 12 * 3600);
    if (typeof clipDurSec === "number" && clipDurSec > 0) {
      if (atSec >= clipDurSec) continue; // starts after the clip ends — pointless
      atSec = Math.min(atSec, Math.max(clipDurSec - dur, 0));
    }

    const fx: ClipEffect = {
      type: t,
      atSec: +atSec.toFixed(3),
      durSec: +dur.toFixed(3),
      intensity: clamp(num(r.intensity, 0.8), 0, 1),
    };
    if (t === "flash" && typeof r.color === "string" && HEX_COLOR.test(r.color.trim())) {
      fx.color = r.color.trim();
    }
    out.push(fx);
    if (out.length >= MAX_EFFECTS_PER_CLIP) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution — preset + overrides + intensity → neutral-based numbers.
// ---------------------------------------------------------------------------

export interface ResolvedGrade {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  vignette: number;
  grain: number;
  intensity: number;
}

export function resolveGrade(spec?: GradeSpec): ResolvedGrade {
  const neutral: ResolvedGrade = {
    brightness: 0, contrast: 0, saturation: 0,
    warmth: 0, vignette: 0, grain: 0, intensity: 1,
  };
  if (!spec) return neutral;
  const base =
    spec.preset && Object.prototype.hasOwnProperty.call(GRADE_PRESETS, spec.preset)
      ? GRADE_PRESETS[spec.preset]
      : {};
  const merged = { ...base, ...spec };
  // intensity blends every delta toward 0 (the ungraded source).
  const k = clamp(num(merged.intensity, 1), 0, 1);
  return {
    brightness: clamp(num(merged.brightness), -0.5, 0.5) * k,
    contrast: clamp(num(merged.contrast), -0.5, 1) * k,
    saturation: clamp(num(merged.saturation), -1, 1) * k,
    warmth: clamp(num(merged.warmth), -1, 1) * k,
    vignette: clamp(num(merged.vignette), 0, 1) * k,
    grain: clamp(num(merged.grain), 0, 1) * k,
    intensity: k,
  };
}

// ---------------------------------------------------------------------------
// Renderers — resolved grade / effects → CSS the Remotion comp consumes.
// ---------------------------------------------------------------------------

/** CSS `filter` for the video layer ("" when the grade is neutral). */
export function gradeToFilter(g: ResolvedGrade): string {
  const parts: string[] = [];
  if (g.brightness) parts.push(`brightness(${(1 + g.brightness).toFixed(3)})`);
  if (g.contrast) parts.push(`contrast(${(1 + g.contrast).toFixed(3)})`);
  if (g.saturation) parts.push(`saturate(${Math.max(0, 1 + g.saturation).toFixed(3)})`);
  return parts.join(" ");
}

/** Warm/cool colour-temperature wash laid over the video (soft-light), or
 *  null when the grade has no warmth component. */
export function gradeTint(g: ResolvedGrade): string | null {
  if (!g.warmth) return null;
  const rgb = g.warmth > 0 ? "255, 158, 64" : "64, 158, 255";
  const alpha = (Math.abs(g.warmth) * 0.4).toFixed(3);
  return `rgba(${rgb}, ${alpha})`;
}

/** Radial-gradient CSS for darkened corners, or null at vignette ~ 0. */
export function gradeVignette(g: ResolvedGrade): string | null {
  if (g.vignette < 0.02) return null;
  const a = (g.vignette * 0.85).toFixed(3);
  return `radial-gradient(ellipse at center, rgba(0,0,0,0) 42%, rgba(0,0,0,${a}) 100%)`;
}

/** Tileable SVG noise used for the animated film-grain layer. */
export const GRAIN_NOISE_URI =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>" +
  "<filter id='g'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/></filter>" +
  "<rect width='160' height='160' filter='url(%23g)'/></svg>\")";

/** Deterministic per-frame jitter for the grain layer (same frame = same
 *  position, so two renders of one plan match). */
export function grainPosition(frame: number): string {
  const fract = (n: number) => {
    const s = Math.sin(n) * 43758.5453;
    return s - Math.floor(s);
  };
  const x = Math.floor(fract(frame * 12.9898) * 160);
  const y = Math.floor(fract(frame * 78.233) * 160);
  return `${x}px ${y}px`;
}

/** 0..1 envelope of an effect at time `sec` on the clip timeline — fast
 *  attack, smooth decay — multiplied by the effect's intensity. */
export function effectEnvelope(fx: ClipEffect, sec: number): number {
  const at = num(fx.atSec, 0);
  const dur = Math.max(num(fx.durSec, DEFAULT_DUR[fx.type]), 0.001);
  const t = (sec - at) / dur;
  if (t < 0 || t > 1) return 0;
  const attack = fx.type === "flash" ? 0.12 : 0.2;
  const env = t < attack ? t / attack : 1 - (t - attack) / (1 - attack);
  return clamp(env, 0, 1) * clamp(num(fx.intensity, 0.8), 0, 1);
}

/** Summed camera-shake offset for every active shake effect at `frame`.
 *  Layered sines — smooth, deterministic, seed-varied per effect so two
 *  shakes never pulse in sync. */
export function combineShake(
  effects: ClipEffect[] | undefined,
  frame: number,
  fps: number
): { x: number; y: number; rot: number } {
  let x = 0, y = 0, rot = 0;
  for (const fx of effects ?? []) {
    if (fx.type !== "shake") continue;
    const env = effectEnvelope(fx, frame / fps);
    if (env <= 0) continue;
    const seed = Math.round(num(fx.atSec, 0) * 100);
    x += (Math.sin(frame * 1.9 + seed) + 0.5 * Math.sin(frame * 3.7 + seed * 0.5)) * 12 * env;
    y += (Math.cos(frame * 2.3 + seed) + 0.5 * Math.sin(frame * 4.1 + seed)) * 10 * env;
    rot += Math.sin(frame * 2.9 + seed * 1.3) * 1.4 * env;
  }
  return { x, y, rot };
}

/** Strongest active flash at `sec`, or null. */
export function flashOverlay(
  effects: ClipEffect[] | undefined,
  sec: number
): { color: string; opacity: number } | null {
  let best: { color: string; opacity: number } | null = null;
  for (const fx of effects ?? []) {
    if (fx.type !== "flash") continue;
    const op = effectEnvelope(fx, sec);
    if (op > 0 && (!best || op > best.opacity)) {
      best = { color: fx.color ?? "#ffffff", opacity: op };
    }
  }
  return best;
}

/** Strongest active light-leak opacity at `sec` (0 = none). */
export function lightLeakOpacity(effects: ClipEffect[] | undefined, sec: number): number {
  let best = 0;
  for (const fx of effects ?? []) {
    if (fx.type !== "lightLeak") continue;
    const op = effectEnvelope(fx, sec);
    if (op > best) best = op;
  }
  return best;
}
