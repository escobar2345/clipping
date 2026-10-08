// lib/actions.ts — the chat assistant's action catalog.
//
// Every page capability the model can drive, executed with the EXACT same
// server logic the UI buttons use. The chat proposes an action; the ChatPanel
// enriches it with live page data (intel, editPlan, renderedUrls…) and calls
// /api/chat/execute, which lands here. Safe/quick actions never need a click;
// expensive or irreversible ones (render, Buffer post, delete) are marked
// needsConfirm so the UI shows a Confirm button first.

import fs from "fs";
import path from "path";
import type {
  VideoIntel,
  EditRules,
  StyleProfile,
  EditPlan,
  ClipEffect,
  GradeSpec,
} from "./types";
import { GRADE_PRESETS, EFFECT_TYPES, sanitizeGrade, sanitizeEffects } from "./colorGrade";
import { editedDurationSec } from "./timeline";
import { analyzeAnyUrl, isYouTubeUrl } from "./anywhere";
import { getVideoDurationSec } from "./ffmpegFrames";
import { localFileUrl } from "./youtube";
import { generateEditPlan as generatePlan } from "./nvidiaGlm";
import { generateEditPlanWithHiggsfield } from "./nvidiaGlmTools";
import { buildVisualContext } from "./visualScan";
import { higgsfieldConfigured } from "./higgsfieldMcp";
import {
  DEFAULT_EDIT_SYSTEM_PROMPT,
  getSavedSystemPrompt,
  saveSystemPrompt,
} from "./prompts";
import { coachCaptions } from "./captionCoach";
import { fetchTrendingSounds } from "./trends";
import { allSpecs } from "./platforms";
import { buildViralPack } from "./viralPack";
import { cutStoryTeaser } from "./storyCut";
import { renderClipToDisk } from "./renderClip";
import { postToBufferTargets } from "./bufferPost";
import {
  createTask,
  deleteTask,
  setTaskEnabled,
  listTasks,
  runTask,
  runHistory,
  ensureScheduler,
} from "./scheduler";


// ---------------------------------------------------------------------------
// ActionOutcome — what an action returns: a result (also the step summary
// shown in chat) plus a state patch that the page UI merges in.
// ---------------------------------------------------------------------------

export interface ActionOutcome {
  result: any;
  statePatch?: any;
}

// ---------------------------------------------------------------------------
// ChatPageContext — a light summary of the page the client sends with every
// chat message so the model knows exactly what is loaded (video, rules, edit
// plan, rendered clips, channels…).
// ---------------------------------------------------------------------------

export interface ChatPageContext {
  configMissing?: string[];
  video?: {
    title?: string;
    durationSec?: number;
    sourceUrl?: string;
    hasFile?: boolean;
    transcriptWords?: number;
  } | null;
  rules?: {
    instructions?: string;
    targetClipCount?: number;
    minClipSec?: number;
    maxClipSec?: number;
    targetPlatforms?: string[];
  } | null;
  styleProfileLoaded?: boolean;
  editPlan?: {
    clips?: {
      clipIndex: number;
      clipId?: string;
      hookTitle?: string;
      startSec?: number;
      endSec?: number;
    }[];
    rendered?: (string | null)[];
    captionsDrafted?: (string | null)[];
  } | null;
  accounts?: {
    accountId?: string;
    accountName?: string;
    channels?: { channelId?: string; service?: string; displayName?: string }[];
  }[];
  storedUploads?: string[];
  renderedFiles?: { file?: string; hookTitle?: string | null; sourceUrl?: string | null }[];
}

// ---------------------------------------------------------------------------
// Catalog table — rendered into the chat system prompt as the ACTION list.
// ---------------------------------------------------------------------------

export interface ActionSpec {
  id: string;
  label: string;
  needsConfirm: boolean;
  example: string;
}

export const ACTION_SPECS: ActionSpec[] = [
  {
    id: "analyze_url",
    label: "analyze a video link and load it into the page",
    needsConfirm: false,
    example: '{"action":"analyze_url","url":"https://youtube.com/watch?v=..."}',
  },
  {
    id: "load_upload",
    label: "load one of the stored videos back into the page",
    needsConfirm: false,
    example: '{"action":"load_upload","file":"up-abc123.mp4"}',
  },
  {
    id: "generate_edit_plan",
    label: "run the AI editor on the loaded video (creates the numbered clip plan)",
    needsConfirm: false,
    example:
      '{"action":"generate_edit_plan","clipCount":3,"minSec":20,"maxSec":60,"targetPlatforms":["tiktok","instagram_reels","youtube_shorts"],"instructions":"prioritize one-liners"}',
  },
  {
    id: "draft_caption",
    label: "write a ready-to-post caption into the page for one clip",
    needsConfirm: false,
    example:
      '{"action":"draft_caption","clipIndex":0,"brief":"focus on the hook and add 3 hashtags"}',
  },
  {
    id: "caption_coach",
    label: "live web research + AI captions, hashtags and tips per platform",
    needsConfirm: false,
    example:
      '{"action":"caption_coach","topic":"AI developer tips","draftCaption":"","platforms":["tiktok","instagram","youtube"]}',
  },
  {
    id: "trending_sounds",
    label: "live trending TikTok sounds + hashtags for a niche",
    needsConfirm: false,
    example: '{"action":"trending_sounds","topic":"fitness"}',
  },
  {
    id: "viral_pack",
    label: "per-platform ready-to-post packs (caption, hashtags, title, timing, checklist)",
    needsConfirm: false,
    example:
      '{"action":"viral_pack","topic":"AI developer tips","draftCaption":"","platformIds":["tiktok","instagram_reels","youtube_shorts"]}',
  },
  {
    id: "story_cut",
    label: "cut a 7-15s Story teaser from a RENDERED clip (ffmpeg)",
    needsConfirm: false,
    example: '{"action":"story_cut","clipIndex":0,"teaserSec":15}',
  },
  {
    id: "apply_grade",
    label: "apply a color grade (cinematic look) to one clip or all clips — re-render to see it",
    needsConfirm: false,
    example: '{"action":"apply_grade","clipIndex":"all","preset":"cinematic","intensity":0.8}',
  },
  {
    id: "add_effect",
    label: "add a timed visual effect (shake = camera rumble, flash = impact hit, lightLeak = warm sweep) to a clip",
    needsConfirm: false,
    example: '{"action":"add_effect","clipIndex":0,"type":"flash","atSec":1.5,"intensity":0.9}',
  },
  {
    id: "clear_effects",
    label: "remove the effects and/or the color grade from one clip or all clips",
    needsConfirm: false,
    example: '{"action":"clear_effects","clipIndex":"all","what":"all"}',
  },
  {
    id: "render_clip",
    label: "render one clip of the edit plan into an mp4",
    needsConfirm: true,
    example: '{"action":"render_clip","clipIndex":0}',
  },
  {
    id: "post_to_buffer",
    label: "post a RENDERED clip to Buffer channels (needs your confirm)",
    needsConfirm: true,
    example:
      '{"action":"post_to_buffer","clipIndex":0,"channels":["<accountId>:<channelId>"],"caption":"...","mode":"queue"}',
  },
  {
    id: "delete_render",
    label: "delete one rendered clip from disk",
    needsConfirm: true,
    example: '{"action":"delete_render","file":"clip-0.mp4"}',
  },
  {
    id: "delete_upload",
    label: "delete one stored source video from disk",
    needsConfirm: true,
    example: '{"action":"delete_upload","file":"up-abc123.mp4"}',
  },
  {
    id: "schedule_create",
    label: "create an automation: run an action on a trigger (every N sec, daily at HH:MM, or once) — no human needed afterwards",
    needsConfirm: false,
    example:
      '{"action":"schedule_create","name":"Post clip 0 daily","trigger":{"kind":"daily","atTime":"09:00"},"actionData":{"action":"post_to_buffer","params":{"clipIndex":0,"channels":["<accountId>:<channelId>"],"caption":"Morning post","mode":"queue"}}}',
  },
  {
    id: "schedule_list",
    label: "list every scheduled automation with its trigger and last-run result",
    needsConfirm: false,
    example: '{"action":"schedule_list"}',
  },
  {
    id: "schedule_delete",
    label: "cancel/delete a scheduled automation by id or name",
    needsConfirm: true,
    example: '{"action":"schedule_delete","id":"Daily 9am post"}',
  },
  {
    id: "schedule_pause",
    label: "pause or resume a scheduled automation (enabled=false/true) without deleting it",
    needsConfirm: false,
    example: '{"action":"schedule_pause","id":"Daily 9am post","enabled":false}',
  },
  {
    id: "schedule_run_now",
    label: "fire a scheduled automation immediately, once, regardless of its trigger",
    needsConfirm: true,
    example: '{"action":"schedule_run_now","id":"Daily 9am post"}',
  },
  {
    id: "schedule_history",
    label: "show the recent run history of all automations (time, ok/fail, result summary)",
    needsConfirm: false,
    example: '{"action":"schedule_history"}',
  },
];

export function actionCatalogText(): string {
  const lines = ACTION_SPECS.map((a) => {
    const trigger = a.needsConfirm ? "requires CONFIRM" : "runs automatically";
    return `- ${a.id}: ${a.label}. ${trigger}. Example: \`${a.example}\``;
  });
  return lines.join("\n");
}

export function actionNeedsConfirm(actionId: string): boolean {
  return ACTION_SPECS.find((a) => a.id === actionId)?.needsConfirm ?? false;
}

// ---------------------------------------------------------------------------
// Executors — mirror the corresponding API routes exactly, so a chat-driven
// action and a button-driven one behave identically.
// ---------------------------------------------------------------------------

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi|mpe?g|flv|ts)$/i;
const SAFE_FILENAME = /^[A-Za-z0-9._-]+$/;

/** Same safety contract as /api/uploads: bare filenames, video extensions only. */
function assertSafeMediaFile(file: string, videoOnly: boolean): string {
  if (!file || file !== path.basename(file) || !SAFE_FILENAME.test(file)) {
    throw new Error("Invalid file name");
  }
  if (videoOnly && !VIDEO_EXT.test(file)) {
    throw new Error("Not a video file");
  }
  return file;
}

export async function analyzeUrl(url: string): Promise<ActionOutcome> {
  if (!url || !String(url).trim()) {
    throw new Error("A video URL is required");
  }
  const { fetchVideoIntel } = await import("./apify");
  let intel: VideoIntel;
  if (!isYouTubeUrl(url)) {
    // ANY platform (TikTok, Instagram, Facebook, X, Vimeo, direct mp4, …):
    // yt-dlp metadata probe + caption harvest. No download, no Apify.
    const info = await analyzeAnyUrl(url);
    intel = {
      sourceUrl: url,
      title: info.title ?? "Untitled",
      durationSec: info.durationSec ?? 0,
      videoFilePath: "",
      transcript: info.transcript,
    };
  } else {
    // YouTube path: Apify gives rich metadata + transcript. This repo's
    // fetchVideoIntel returns an IntelResult wrapper — unwrap the VideoIntel.
    intel = (await fetchVideoIntel(url)).intel;
  }
  return {
    result: { intel, videoFilePending: !intel.videoFilePath, url },
    statePatch: { intel, filePending: !intel.videoFilePath },
  };
}

export async function loadStoredUpload(file: string): Promise<ActionOutcome> {
  assertSafeMediaFile(file, true);
  const target = path.join(process.cwd(), "public", "uploads", file);
  if (!fs.existsSync(target)) {
    throw new Error(`No stored video named ${file} exists`);
  }
  const durationSec = await getVideoDurationSec(target);
  if (!durationSec || durationSec < 1) {
    throw new Error(`Couldn't read video duration from ${file}`);
  }
  const intel: VideoIntel = {
    sourceUrl: "",
    title: file,
    durationSec,
    videoFilePath: localFileUrl(`/uploads/${file}`),
    transcript: [],
  };
  return {
    result: { intel, videoFilePending: false },
    statePatch: { intel, filePending: false },
  };
}

export async function generateEditPlan(params: {
  intel: VideoIntel;
  rules: EditRules;
  styleProfile?: StyleProfile;
  systemPrompt?: string;
  targetPlatforms?: string[];
  enableHiggsfield?: boolean;
}): Promise<ActionOutcome> {
  const { intel, rules } = params;
  if (!intel || !rules) {
    throw new Error("intel and rules are required for generate_edit_plan");
  }

  // Same prompt persistence contract as /api/edit-plan.
  let systemPrompt: string;
  if (typeof params.systemPrompt === "string") {
    const sp = params.systemPrompt.trim();
    saveSystemPrompt(sp.length ? sp : null);
    systemPrompt = sp.length ? sp : DEFAULT_EDIT_SYSTEM_PROMPT;
  } else {
    systemPrompt = getSavedSystemPrompt() ?? DEFAULT_EDIT_SYSTEM_PROMPT;
  }

  // Visual intelligence: exact scene cuts + vision-model frame notes. Best-effort.
  let visualContext = null;
  try {
    visualContext = await buildVisualContext(
      intel,
      210_000,
      String(rules?.instructions ?? "")
    );
  } catch {
    visualContext = null;
  }

  let result;
  const enableHiggsfield = params.enableHiggsfield !== false;
  if (enableHiggsfield && (await higgsfieldConfigured())) {
    result = await generateEditPlanWithHiggsfield(
      intel,
      rules,
      params.styleProfile,
      systemPrompt,
      visualContext,
      true,
      5,
      params.targetPlatforms
    );
  } else {
    const editPlan = await generatePlan(
      intel,
      rules,
      params.styleProfile,
      systemPrompt,
      visualContext,
      params.targetPlatforms
    );
    result = { editPlan, toolRounds: [], higgsfieldAvailable: false };
  }

  return {
    result: {
      editPlan: result.editPlan,
      higgsfieldAvailable: result.higgsfieldAvailable,
      clipCount: result.editPlan?.clips?.length ?? 0,
    },
    statePatch: { editPlan: result.editPlan },
  };
}

export async function renderClip(params: {
  editPlan: EditPlan;
  clipIndex: number;
  sourceUrl?: string;
}): Promise<ActionOutcome> {
  const { url, clipId } = await renderClipToDisk(
    params.editPlan,
    params.clipIndex,
    params.sourceUrl
  );
  const hook = params.editPlan?.clips?.[params.clipIndex]?.hookTitle ?? clipId;
  return {
    result: { url, clipId, hook },
    statePatch: { renderedUrls: { [params.clipIndex]: url }, refreshRenders: true },
  };
}

export async function draftCaption(params: {
  clipIndex: number;
  brief?: string;
  draftCaption?: string;
  platforms?: string[];
}): Promise<ActionOutcome> {
  const clipIndex = Number(params.clipIndex ?? 0);
  const topic = String(params.brief ?? params.draftCaption ?? "").trim();
  if (!topic) {
    throw new Error("A brief/topic is required to draft a caption");
  }
  const platforms =
    Array.isArray(params.platforms) && params.platforms.length
      ? params.platforms
      : ["instagram"];
  const result = await coachCaptions({
    topic,
    draftCaption: params.draftCaption || undefined,
    platforms,
    research: [], // skip live research — just a quick draft from the brief
  });
  const first = result.captions?.[0];
  if (!first?.caption) {
    throw new Error("The model returned no usable caption");
  }
  return {
    result: { caption: first.caption, platform: first.platform, clipIndex },
    statePatch: { captions: { [clipIndex]: first.caption } },
  };
}

export async function captionCoach(params: {
  topic: string;
  draftCaption?: string;
  platforms?: string[];
  skipResearch?: boolean;
}): Promise<ActionOutcome> {
  if (!params.topic || !String(params.topic).trim()) {
    throw new Error("topic is required");
  }
  const { researchTopic } = await import("./apify");
  const platforms =
    Array.isArray(params.platforms) && params.platforms.length
      ? params.platforms
      : ["tiktok", "instagram", "youtube"];
  let research: Awaited<ReturnType<typeof researchTopic>> = [];
  let researchError: string | undefined;
  if (!params.skipResearch) {
    try {
      research = await researchTopic(String(params.topic));
    } catch (err: any) {
      researchError = err.message;
    }
  }
  const result = await coachCaptions({
    topic: String(params.topic),
    draftCaption: params.draftCaption || undefined,
    platforms,
    research,
  });
  return {
    result: {
      ...result,
      researchError,
      captionCount: result.captions?.length ?? 0,
    },
  };
}

export async function trendingSounds(topic: string): Promise<ActionOutcome> {
  if (!topic || !String(topic).trim()) {
    throw new Error("topic is required");
  }
  const pack = await fetchTrendingSounds(String(topic));
  return {
    result: { ...pack, soundCount: pack.sounds?.length ?? 0 },
  };
}

export async function viralPack(params: {
  topic: string;
  draftCaption?: string;
  hookTitle?: string;
  platformIds?: string[];
  includeStory?: boolean;
  skipResearch?: boolean;
}): Promise<ActionOutcome> {
  if (!params.topic || typeof params.topic !== "string") {
    throw new Error("topic is required");
  }
  const { researchTopic } = await import("./apify");
  const all = allSpecs();
  let platforms =
    Array.isArray(params.platformIds) && params.platformIds.length
      ? all.filter((p) => (params.platformIds as string[]).includes(p.id))
      : all.filter((p) => p.id !== "instagram_story");
  if (params.includeStory && !platforms.find((p) => p.id === "instagram_story")) {
    const story = all.find((p) => p.id === "instagram_story");
    if (story) platforms = [...platforms, story];
  }
  if (!platforms.length) platforms = all;

  let research: Awaited<ReturnType<typeof researchTopic>> = [];
  let researchError: string | undefined;
  if (!params.skipResearch) {
    try {
      research = await researchTopic(params.topic);
    } catch (e: any) {
      researchError = e.message;
    }
  }
  let sounds: Awaited<ReturnType<typeof fetchTrendingSounds>>["sounds"] = [];
  let soundsNote = "";
  try {
    const pack = await fetchTrendingSounds(params.topic);
    sounds = pack.sounds;
    soundsNote = pack.note;
  } catch (e: any) {
    soundsNote = e.message;
  }
  const result = await buildViralPack({
    topic: params.topic,
    draftCaption: params.draftCaption,
    hookTitle: params.hookTitle,
    platforms,
    research,
    sounds,
  });
  return {
    result: {
      ...result,
      research,
      sounds,
      soundsNote,
      researchError,
      platformCount: result.captions?.length ?? 0,
    },
  };
}

export async function storyCut(params: {
  renderedPath: string;
  teaserSec?: number;
}): Promise<ActionOutcome> {
  if (!params.renderedPath || !String(params.renderedPath).trim()) {
    throw new Error("renderedPath is required for story_cut");
  }
  const sec = Math.min(Math.max(Number(params.teaserSec ?? 15), 5), 60);
  const url = await cutStoryTeaser(params.renderedPath, sec);
  return {
    result: { url, teaserSec: sec },
    statePatch: { refreshRenders: true },
  };
}

export async function postToBuffer(params: {
  clipIndex: number;
  renderedPath: string;
  targets: {
    accountId: string;
    channelId: string;
    service?: string;
    postType?: string;
    caption?: string;
  }[];
  caption: string;
  mode: string;
  dueAtIso?: string;
}): Promise<ActionOutcome> {
  if (!params.caption || !String(params.caption).trim()) {
    throw new Error("A caption is required to post");
  }
  const data = await postToBufferTargets({
    renderedPath: params.renderedPath,
    targets: params.targets,
    caption: params.caption,
    mode: params.mode === "schedule" ? "schedule" : "queue",
    dueAtIso: params.dueAtIso,
  });
  const clipIndex = Number(params.clipIndex ?? 0);
  const summary = `Queued on ${data.summary.succeeded}/${data.summary.total} channels${
    data.summary.failed > 0 ? ` · ${data.summary.failed} failed` : ""
  } ✓`;
  return {
    result: data,
    statePatch: { postResult: { [clipIndex]: summary } },
  };
}

export async function deleteRender(file: string): Promise<ActionOutcome> {
  assertSafeMediaFile(file, false);
  if (!file.toLowerCase().endsWith(".mp4")) {
    throw new Error("Invalid file name");
  }
  const dir = path.join(process.cwd(), "public", "renders");
  const target = path.join(dir, file);
  if (!fs.existsSync(target)) {
    throw new Error(`No rendered clip named ${file} exists`);
  }
  fs.unlinkSync(target);
  // Keep manifest.json in sync so the UI never points at a ghost clip.
  const manifestPath = path.join(dir, "manifest.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (Array.isArray(parsed.renders)) {
      fs.writeFileSync(
        manifestPath,
        JSON.stringify(
          { renders: parsed.renders.filter((r: any) => r.file !== file) },
          null,
          2
        )
      );
    }
  } catch {
    /* no manifest yet — nothing to sync */
  }
  return { result: { ok: true, file }, statePatch: { refreshRenders: true } };
}

export async function deleteUpload(file: string): Promise<ActionOutcome> {
  assertSafeMediaFile(file, true);
  const dir = path.join(process.cwd(), "public", "uploads");
  const target = path.join(dir, file);
  if (!fs.existsSync(target)) {
    throw new Error(`No stored video named ${file} exists`);
  }
  fs.unlinkSync(target);
  // Best-effort cleanup of caption sidecars saved alongside URL downloads.
  const base = file.replace(/\.[^.]+$/, "");
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${base}.`)) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        /* sidecar cleanup is best-effort */
      }
    }
  }
  return { result: { ok: true, file }, statePatch: { refreshUploads: true } };
}

// ---------------------------------------------------------------------------
// Color grading + visual effects — write the look into the plan;
// lib/colorGrade.ts renders it when Remotion composites the clip.
// ---------------------------------------------------------------------------

function requirePlan(editPlan: any): EditPlan {
  if (!editPlan?.clips?.length) {
    throw new Error("No edit plan loaded — generate an edit plan first.");
  }
  return editPlan as EditPlan;
}

/** clipIndex resolution: "all" / omitted = every clip, otherwise one index. */
function targetClipIndexes(count: number, clipIndex: unknown): number[] {
  if (clipIndex == null || clipIndex === "all" || clipIndex === "*") {
    return Array.from({ length: count }, (_, i) => i);
  }
  const i = Number(clipIndex);
  if (!Number.isInteger(i) || i < 0 || i >= count) {
    throw new Error(
      `clipIndex ${JSON.stringify(clipIndex)} is out of range — use 0..${count - 1} or "all".`
    );
  }
  return [i];
}

export async function applyGrade(params: {
  editPlan: EditPlan;
  clipIndex?: number | "all";
  preset?: string;
  intensity?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  warmth?: number;
  vignette?: number;
  grain?: number;
}): Promise<ActionOutcome> {
  const plan = requirePlan(params.editPlan);
  const targets = targetClipIndexes(plan.clips.length, params.clipIndex);
  const requested = String(params.preset ?? "").trim().toLowerCase();

  let grade: GradeSpec | undefined;
  if (requested === "none" || requested === "clear" || requested === "off") {
    grade = undefined; // deliberate removal
  } else {
    if (requested && !Object.prototype.hasOwnProperty.call(GRADE_PRESETS, requested)) {
      throw new Error(
        `Unknown grade preset "${params.preset}". Pick one of: ` +
          `${Object.keys(GRADE_PRESETS).join(", ")} — or "none" to remove the grade.`
      );
    }
    const spec: GradeSpec = requested ? { preset: requested } : {};
    for (const k of ["intensity", "brightness", "contrast", "saturation", "warmth", "vignette", "grain"] as const) {
      if (params[k] !== undefined) spec[k] = params[k];
    }
    grade = sanitizeGrade(spec);
    if (!grade) {
      throw new Error('Nothing to apply — pass a preset (e.g. "cinematic") or numeric grade fields.');
    }
  }

  const clips = plan.clips.map((c, i) => {
    if (!targets.includes(i)) return c;
    const next = { ...c };
    if (grade) next.grade = grade;
    else delete next.grade;
    return next;
  });

  return {
    result: {
      ok: true,
      preset: grade?.preset ?? (grade ? "custom" : "none"),
      clipIndexes: targets,
      grade: grade ?? null,
    },
    statePatch: { editPlan: { ...plan, clips } },
  };
}

export async function addEffect(params: {
  editPlan: EditPlan;
  clipIndex?: number | "all";
  type: string;
  atSec?: number;
  durSec?: number;
  intensity?: number;
  color?: string;
}): Promise<ActionOutcome> {
  const plan = requirePlan(params.editPlan);
  const targets = targetClipIndexes(plan.clips.length, params.clipIndex);
  const type = String(params.type ?? "").trim();
  if (!(EFFECT_TYPES as readonly string[]).includes(type)) {
    throw new Error(`Unknown effect type "${params.type}". Pick one of: ${EFFECT_TYPES.join(", ")}.`);
  }

  let applied: ClipEffect | null = null;
  const fxs = new Map<number, ClipEffect>();
  for (const i of targets) {
    const dur = editedDurationSec(plan.clips[i]);
    const [fx] = sanitizeEffects(
      [{ type, atSec: params.atSec, durSec: params.durSec, intensity: params.intensity, color: params.color }],
      dur
    );
    if (!fx) {
      throw new Error(`atSec ${params.atSec} is past the end of clip ${i} (${dur.toFixed(1)}s).`);
    }
    applied = applied ?? fx;
    fxs.set(i, fx);
  }
  if (!applied) throw new Error("Effect could not be applied.");

  const clips = plan.clips.map((c, i) => {
    const fx = fxs.get(i);
    if (!fx) return c;
    return { ...c, effects: [...(c.effects ?? []), fx].slice(-8) };
  });

  return {
    result: {
      ok: true,
      type,
      clipIndexes: targets,
      atSec: applied.atSec,
      durSec: applied.durSec,
    },
    statePatch: { editPlan: { ...plan, clips } },
  };
}

export async function clearEffects(params: {
  editPlan: EditPlan;
  clipIndex?: number | "all";
  what?: string;
}): Promise<ActionOutcome> {
  const plan = requirePlan(params.editPlan);
  const targets = targetClipIndexes(plan.clips.length, params.clipIndex);
  const whatRaw = String(params.what ?? "all").trim().toLowerCase();
  const what = whatRaw === "effects" || whatRaw === "grade" ? whatRaw : "all";

  const clips = plan.clips.map((c, i) => {
    if (!targets.includes(i)) return c;
    const next = { ...c };
    if (what === "effects" || what === "all") delete next.effects;
    if (what === "grade" || what === "all") delete next.grade;
    return next;
  });

  return {
    result: { ok: true, cleared: what, clipIndexes: targets },
    statePatch: { editPlan: { ...plan, clips } },
  };
}

// ---------------------------------------------------------------------------
// Dispatcher — /api/chat/execute lands here for every new-style action.
// ---------------------------------------------------------------------------

const EXECUTORS: Record<string, (p: any) => Promise<ActionOutcome>> = {
  analyze_url: (p) => analyzeUrl(p?.url ?? p?.youtubeUrl ?? ""),
  load_upload: (p) => loadStoredUpload(p?.file ?? ""),
  generate_edit_plan: (p) => generateEditPlan(p ?? {}),
  render_clip: (p) => renderClip(p ?? {}),
  draft_caption: (p) => draftCaption(p ?? {}),
  caption_coach: (p) => captionCoach(p ?? {}),
  trending_sounds: (p) => trendingSounds(p?.topic ?? ""),
  viral_pack: (p) => viralPack(p ?? {}),
  story_cut: (p) => storyCut(p ?? {}),
  apply_grade: (p) => applyGrade(p ?? {}),
  add_effect: (p) => addEffect(p ?? {}),
  clear_effects: (p) => clearEffects(p ?? {}),
  post_to_buffer: (p) => postToBuffer(p ?? {}),
  delete_render: (p) => deleteRender(p?.file ?? ""),
  delete_upload: (p) => deleteUpload(p?.file ?? ""),
  // ---- Automations (lib/scheduler.ts) -------------------------------------
  schedule_create: (p) => {
    // Inner action arrives under actionData to avoid key collision with the
    // outer "action" id. Accept "action" as a legacy alias.
    const inner = p?.actionData ?? p?.task ?? {};
    const task = createTask({
      name: p?.name,
      trigger: p?.trigger,
      action: {
        action: String(inner.action ?? inner?.action ?? ""),
        params: inner.params ?? {},
      },
    });
    ensureScheduler();
    return Promise.resolve({
      result: { ok: true, task },
      statePatch: { refreshSchedule: true },
    });
  },
  schedule_list: () =>
    Promise.resolve({
      result: { ok: true, tasks: listTasks() },
      statePatch: { refreshSchedule: true },
    }),
  schedule_delete: (p) => {
    const removed = deleteTask(String(p?.id ?? p?.name ?? ""));
    return Promise.resolve({
      result: { ok: true, removed },
      statePatch: { refreshSchedule: true },
    });
  },
  schedule_pause: (p) => {
    const t = setTaskEnabled(String(p?.id ?? p?.name ?? ""), Boolean(p?.enabled));
    return Promise.resolve({
      result: { ok: true, task: t },
      statePatch: { refreshSchedule: true },
    });
  },
  schedule_run_now: async (p) => {
    const tasks = listTasks();
    const task = tasks.find(
      (t) => t.id === String(p?.id ?? "") || t.name === String(p?.id ?? p?.name ?? "")
    );
    if (!task) throw new Error(`No scheduled task matching "${p?.id ?? p?.name ?? ""}"`);
    const rec = await runTask(task);
    return { result: { ok: rec.ok, run: rec }, statePatch: { refreshSchedule: true } };
  },
  schedule_history: () =>
    Promise.resolve({
      result: { ok: true, history: runHistory(30) },
    }),
};

export async function executeChatAction(
  kind: string,
  params: any
): Promise<ActionOutcome> {
  const fn = EXECUTORS[kind];
  if (!fn) {
    throw new Error(`Unknown action type: ${kind}`);
  }
  return await fn(params);
}

/** Short human label for a single action (used in chat step chips). */
export function actionLabel(kind: string): string {
  return ACTION_SPECS.find((a) => a.id === kind)?.label.split(" (")[0] ?? kind;
}

/** Compact one-line summary of an outcome, fed back to the model after a step. */
export function summarizeOutcome(kind: string, outcome: ActionOutcome): string {
  const r = outcome?.result ?? {};
  try {
    switch (kind) {
      case "analyze_url":
        return `Loaded "${r.intel?.title}" (${Math.round(r.intel?.durationSec ?? 0)}s, ${r.intel?.transcript?.length ?? 0} transcript words, video file on disk: ${r.videoFilePending ? "no" : "yes"}).`;
      case "load_upload":
        return `Loaded stored video "${r.intel?.title}".`;
      case "generate_edit_plan":
        return `Edit plan ready: ${r.clipCount ?? "?"} clips.`;
      case "render_clip":
        return `Rendered "${r.hook ?? r.clipId}" -> ${r.url}.`;
      case "draft_caption":
        return `Caption drafted for clip ${r.clipIndex} (${r.platform}): "${String(r.caption ?? "").slice(0, 140)}".`;
      case "caption_coach":
        return `Caption coach: ${r.captionCount ?? 0} platform captions + ${(r.tips ?? []).length} tips.`;
      case "trending_sounds":
        return `Found ${r.soundCount ?? 0} trending sounds + ${(r.hashtags ?? []).length} hashtags for "${r.topic}".`;
      case "viral_pack":
        return `Viral packs ready for ${r.platformCount ?? 0} platforms.`;
      case "story_cut":
        return `Story teaser cut -> ${r.url}.`;
      case "apply_grade": {
        const list = (r.clipIndexes ?? []).join(", ");
        return r.preset === "none"
          ? `Color grade removed from clip(s) ${list}.`
          : `Color grade "${r.preset}" applied to clip(s) ${list} — re-render to see it.`;
      }
      case "add_effect":
        return `${r.type} effect added at ${r.atSec}s to clip(s) ${(r.clipIndexes ?? []).join(", ")} — re-render to see it.`;
      case "clear_effects":
        return `Cleared ${r.cleared} from clip(s) ${(r.clipIndexes ?? []).join(", ")}.`;
      case "post_to_buffer":
        return `Posted to ${r.summary?.succeeded ?? 0}/${r.summary?.total ?? 0} channels.`;
      case "delete_render":
        return `Deleted rendered clip ${r.file}.`;
      case "delete_upload":
        return `Deleted stored video ${r.file}.`;
      case "schedule_create": {
        const t = r.task ?? {};
        const tr = t.trigger ?? {};
        const desc =
          tr.kind === "interval"
            ? `every ${tr.intervalSec}s`
            : tr.kind === "daily"
              ? `daily at ${tr.atTime}`
              : `once at ${tr.runAt}`;
        return `Automation "${t.name}" created (${desc}) running ${t.action?.action ?? "?"} — it will fire on its own.`;
      }
      case "schedule_list": {
        const tasks = r.tasks ?? [];
        if (!tasks.length) return "No automations scheduled yet.";
        return tasks
          .map((t: any) => {
            const tr = t.trigger ?? {};
            const trig =
              tr.kind === "interval"
                ? `every ${tr.intervalSec}s`
                : tr.kind === "daily"
                  ? `daily at ${tr.atTime}`
                  : `once at ${tr.runAt}`;
            return `"${t.name}" (${t.id}) — ${trig}, ${t.enabled ? "active" : "paused"}, runs: ${t.runCount ?? 0}${t.lastError ? `, last error: ${String(t.lastError).slice(0, 80)}` : ""}`;
          })
          .join(" | ");
      }
      case "schedule_delete":
        return `Automation "${r.removed?.name}" cancelled.`;
      case "schedule_pause":
        return `Automation "${r.task?.name}" is now ${r.task?.enabled ? "active" : "paused"}.`;
      case "schedule_run_now":
        return `${r.ok ? "Ran" : "FAILED"} "${r.run?.taskName}" now: ${r.run?.summary ?? ""}`;
      case "schedule_history": {
        const h = r.history ?? [];
        if (!h.length) return "No automation runs recorded yet.";
        return h
          .slice(0, 10)
          .map((x: any) => `${x.at} — "${x.taskName}" (${x.action}): ${x.ok ? "ok" : "FAILED"} — ${x.summary}`)
          .join(" | ");
      }
      default:
        return JSON.stringify(r).slice(0, 200);
    }
  } catch {
    return JSON.stringify(r).slice(0, 200);
  }
}