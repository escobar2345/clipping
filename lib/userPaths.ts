import fs from "fs";
import os from "os";
import path from "path";
import { AsyncLocalStorage } from "async_hooks";

/**
 * Per-user storage.
 *
 * Before this existed every user's files shared one directory, so any signed-in
 * user could list and read everyone else's source videos, rendered clips and —
 * worst of all — the Buffer API tokens in `data/accounts.json`.
 *
 * Layout, scoped to the signed-in user:
 *   public/uploads/<userId>/    source videos
 *   public/renders/<userId>/    rendered clips + manifest.json
 *   public/voice/<userId>/      generated voice files
 *   data/users/<userId>/        Buffer accounts, prompts, transcripts
 *
 * The user id comes from `runAsUser()`, which every route handler wraps itself
 * in (see lib/withAuth.ts). AsyncLocalStorage is what makes that safe: the id
 * travels with the async call chain, so two users being served concurrently can
 * never read each other's directory. A plain module-level variable would race.
 *
 * Every helper THROWS when there's no signed-in user in scope — failing loudly
 * beats silently falling back to a shared folder and leaking everyone's data.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Rejects anything that isn't a plain UUID. */
export function assertSafeUserId(userId: string): string {
  if (!userId || !UUID_RE.test(userId)) {
    throw new Error(`Refusing to build a storage path for an unsafe user id: ${userId}`);
  }
  return userId;
}

const store = new AsyncLocalStorage<string>();

/** Runs `fn` with `userId` as the current user for everything it touches. */
export function runAsUser<T>(userId: string, fn: () => T): T {
  return store.run(assertSafeUserId(userId), fn);
}

/** The signed-in user id for this async call chain, or null. */
export function peekUserId(): string | null {
  return store.getStore() ?? null;
}

/** The signed-in user id, throwing if the caller forgot to wrap itself. */
export function currentUserId(): string {
  const id = store.getStore();
  if (!id) {
    throw new Error(
      "No signed-in user in scope. Route handlers must be wrapped with withAuth() " +
        "(lib/withAuth.ts) so per-user storage resolves correctly."
    );
  }
  return id;
}

function root(...parts: string[]): string {
  return path.join(process.cwd(), ...parts);
}

/** This user's source videos. Created on demand. */
export function uploadsDir(): string {
  const dir = root("public", "uploads", currentUserId());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** This user's rendered clips (plus their own manifest.json). Created on demand. */
export function rendersDir(): string {
  const dir = root("public", "renders", currentUserId());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** This user's generated voice files. Created on demand. */
export function voiceDir(): string {
  const dir = root("public", "voice", currentUserId());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * This user's private data dir (Buffer tokens, prompts, transcripts). Falls back
 * to a temp dir on read-only hosts, mirroring lib/storage.ts, but keeps the
 * per-user subtree so one host's users can never read each other's.
 */
export function dataDir(): string {
  const safe = currentUserId();
  const localDir = root("data", "users", safe);
  try {
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, ".write-probe"), "ok");
    fs.rmSync(path.join(localDir, ".write-probe"));
    return localDir;
  } catch {
    const tmpDir = path.join(os.tmpdir(), "long2short", "users", safe);
    fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }
}

/**
 * Public URL for one of this user's files. The userId segment is part of the
 * path, so Remotion's headless Chromium fetches /uploads/<userId>/clip.mp4 and
 * never another account's media.
 */
export function uploadsUrlPath(fileName: string): string {
  return `/uploads/${currentUserId()}/${path.basename(fileName)}`;
}

export function rendersUrlPath(fileName: string): string {
  return `/renders/${currentUserId()}/${path.basename(fileName)}`;
}

export function voiceUrlPath(fileName: string): string {
  return `/voice/${currentUserId()}/${path.basename(fileName)}`;
}

/**
 * Guards against path traversal in a client-supplied file name. Returns the
 * absolute path only when it stays inside `dir`, else null.
 */
export function resolveInsideDir(dir: string, fileName: string): string | null {
  if (!fileName || fileName.includes("\0")) return null;
  const base = path.resolve(dir);
  const target = path.resolve(base, path.basename(fileName));
  return target === base || target.startsWith(base + path.sep) ? target : null;
}