// lib/scheduler.ts — persistent recurring tasks the chat AI can create.
//
// The copilot can register an "automation": a real page action (render, post
// to Buffer, viral pack, …) plus a TRIGGER. The scheduler persists tasks to
// data/scheduled-tasks.json, keeps a background timer alive inside the Next.js
// server, and fires each task when its trigger hits — running the SAME
// executors in lib/actions.ts the buttons use, with no human involved. Every
// run is appended to a history file the chat can read back.
//
// Trigger kinds:
//   interval : every N seconds  (e.g. 3600 = hourly)
//   daily    : every day at "HH:MM" local time
//   once     : one-shot at an ISO timestamp (task deletes itself after)

import fs from "fs";
import path from "path";
import { executeChatAction, summarizeOutcome } from "./actions";
import type { ActionOutcome } from "./actions";

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface ScheduledTask {
  id: string;
  name: string;
  trigger: {
    kind: "interval" | "daily" | "once";
    intervalSec?: number; // interval
    atTime?: string; // daily, "HH:MM" (local server time)
    runAt?: string; // once, ISO timestamp
  };
  action: {
    action: string; // executor id from EXECUTORS
    params?: Record<string, any>;
  };
  // The user explicitly asked for this automation in chat, so confirm-gated
  // actions (render, post) are pre-approved at creation time.
  createdAt: string;
  lastRun?: string;
  lastError?: string;
  runCount: number;
  enabled: boolean;
}

interface RunRecord {
  taskId: string;
  taskName: string;
  action: string;
  at: string;
  ok: boolean;
  summary: string;
}

const DATA_DIR = path.join(process.cwd(), "data");
const TASKS_FILE = path.join(DATA_DIR, "scheduled-tasks.json");
const HISTORY_FILE = path.join(DATA_DIR, "scheduler-history.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown) {
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}

export function listTasks(): ScheduledTask[] {
  return readJson<ScheduledTask[]>(TASKS_FILE, []);
}

function saveTasks(tasks: ScheduledTask[]) {
  writeJson(TASKS_FILE, tasks);
}

export function runHistory(limit = 30): RunRecord[] {
  return readJson<RunRecord[]>(HISTORY_FILE, []).slice(-limit).reverse();
}

function appendHistory(rec: RunRecord) {
  const all = readJson<RunRecord[]>(HISTORY_FILE, []);
  all.push(rec);
  writeJson(HISTORY_FILE, all.slice(-200));
}

// ---------------------------------------------------------------------------
// CRUD — called by the schedule_* chat actions
// ---------------------------------------------------------------------------

export function createTask(input: {
  name?: string;
  trigger?: ScheduledTask["trigger"];
  action?: ScheduledTask["action"];
}): ScheduledTask {
  const name = String(input.name ?? "").trim() || "Untitled automation";
  const trigger = input.trigger ?? ({} as ScheduledTask["trigger"]);
  const action = input.action ?? ({} as ScheduledTask["action"]);

  const kind = trigger.kind;
  if (kind !== "interval" && kind !== "daily" && kind !== "once") {
    throw new Error('trigger.kind must be "interval", "daily" or "once"');
  }
  if (kind === "interval") {
    const n = Number(trigger.intervalSec);
    if (!Number.isFinite(n) || n < 60) {
      throw new Error("interval trigger needs intervalSec >= 60 (1 minute minimum)");
    }
  }
  if (kind === "daily") {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(trigger.atTime ?? ""))) {
      throw new Error('daily trigger needs atTime as "HH:MM" (24h, local time)');
    }
  }
  if (kind === "once") {
    const t = Date.parse(String(trigger.runAt ?? ""));
    if (Number.isNaN(t) || t <= Date.now()) {
      throw new Error("once trigger needs runAt as a future ISO timestamp");
    }
  }
  if (!action.action || typeof action.action !== "string") {
    throw new Error("action.action (an executor id like render_clip or post_to_buffer) is required");
  }

  const task: ScheduledTask = {
    id: `sk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    trigger: {
      kind,
      ...(kind === "interval" ? { intervalSec: Number(trigger.intervalSec) } : {}),
      ...(kind === "daily" ? { atTime: String(trigger.atTime) } : {}),
      ...(kind === "once" ? { runAt: String(trigger.runAt) } : {}),
    },
    action: { action: String(action.action), params: action.params ?? {} },
    createdAt: new Date().toISOString(),
    runCount: 0,
    enabled: true,
  };
  const tasks = listTasks();
  tasks.push(task);
  saveTasks(tasks);
  ensureScheduler(); // a fresh "once" task needs the loop running even if idle
  return task;
}

export function deleteTask(id: string): ScheduledTask {
  const tasks = listTasks();
  const idx = tasks.findIndex((t) => t.id === id || t.name === id);
  if (idx === -1) throw new Error(`No scheduled task matching "${id}"`);
  const [removed] = tasks.splice(idx, 1);
  saveTasks(tasks);
  return removed;
}

export function setTaskEnabled(id: string, enabled: boolean): ScheduledTask {
  const tasks = listTasks();
  const t = tasks.find((x) => x.id === id || x.name === id);
  if (!t) throw new Error(`No scheduled task matching "${id}"`);
  t.enabled = enabled;
  saveTasks(tasks);
  return t;
}

// ---------------------------------------------------------------------------
// Trigger evaluation + execution
// ---------------------------------------------------------------------------

/** Has this task's trigger fired as of now? */
function isDue(task: ScheduledTask, now = new Date()): boolean {
  if (!task.enabled) return false;
  const last = task.lastRun ? Date.parse(task.lastRun) : NaN;
  switch (task.trigger.kind) {
    case "once": {
      const t = Date.parse(String(task.trigger.runAt));
      return Number.isFinite(t) && now.getTime() >= t;
    }
    case "interval": {
      const every = (task.trigger.intervalSec ?? 0) * 1000;
      return every > 0 && (Number.isNaN(last) || now.getTime() - last >= every);
    }
    case "daily": {
      const [hh, mm] = String(task.trigger.atTime ?? "").split(":").map(Number);
      const due = new Date(now);
      due.setHours(hh, mm, 0, 0);
      // Fires when now is past today's HH:MM AND lastRun was before it.
      return now.getTime() >= due.getTime() && (Number.isNaN(last) || last < due.getTime());
    }
    default:
      return false;
  }
}

/** Runs one task NOW regardless of its trigger (also used by the tick loop). */
export async function runTask(task: ScheduledTask): Promise<RunRecord> {
  const at = new Date().toISOString();
  let ok = true;
  let summary = "";
  try {
    const outcome: ActionOutcome = await executeChatAction(
      task.action.action,
      task.action.params ?? {}
    );
    summary = summarizeOutcome(task.action.action, outcome);
  } catch (err: any) {
    ok = false;
    summary = String(err?.message ?? err);
  }
  const rec: RunRecord = {
    taskId: task.id,
    taskName: task.name,
    action: task.action.action,
    at,
    ok,
    summary,
  };
  appendHistory(rec);

  // Update bookkeeping; one-shot tasks remove themselves after firing.
  const tasks = listTasks();
  const idx = tasks.findIndex((t) => t.id === task.id);
  if (idx !== -1) {
    if (tasks[idx].trigger.kind === "once") {
      tasks.splice(idx, 1);
    } else {
      tasks[idx].lastRun = at;
      tasks[idx].lastError = ok ? undefined : summary.slice(0, 300);
      tasks[idx].runCount += 1;
    }
    saveTasks(tasks);
  }
  return rec;
}

/** Check every persisted task and fire the due ones. Returns run records. */
export async function tick(): Promise<RunRecord[]> {
  const tasks = listTasks();
  const fired: RunRecord[] = [];
  for (const task of tasks) {
    if (isDue(task)) {
      // Serial on purpose: two heavy actions (two renders) must not stomp
      // the same clip files concurrently.
      fired.push(await runTask(task));
    }
  }
  return fired;
}

// ---------------------------------------------------------------------------
// Background loop — started lazily the first time any scheduler-aware module
// loads (chat route, scheduler API route). Survives for the life of the dev
// server process. 30s granularity: triggers are minute-scale anyway.
// ---------------------------------------------------------------------------

const TICK_MS = 30_000;
// Attach to globalThis so Next.js dev hot-reloads don't spawn duplicate timers.
const g = globalThis as any;
if (!g.__l2sScheduler) {
  g.__l2sScheduler = { timer: null as any, started: false };
}

export function ensureScheduler(): void {
  if (g.__l2sScheduler.started) return;
  g.__l2sScheduler.started = true;
  g.__l2sScheduler.timer = setInterval(() => {
    tick().catch(() => {
      /* a failed tick must never kill the loop */
    });
  }, TICK_MS);
  // Don't hold the process open on its own account.
  if (g.__l2sScheduler.timer?.unref) g.__l2sScheduler.timer.unref();
}


