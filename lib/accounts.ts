import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { dataDir } from "./userPaths";
import type { PublicAccount } from "./clientTypes";

/**
 * Saved Buffer accounts — one entry per personal API key pasted in the UI.
 * Stored server-side in data/users/<userId>/accounts.json (gitignored); the raw
 * access token never leaves the server (the browser only ever sees
 * `PublicAccount`).
 *
 * Per-user, not global: these are real credentials that can post to someone's
 * social accounts, so one user must never see another's.
 *
 * While NO accounts are saved, BUFFER_ACCESS_TOKEN/BUFFER_ORGANIZATION_ID from
 * the environment show up as a fallback "Default" account (see README), so
 * older env-only setups keep working unchanged.
 */
export interface StoredAccount {
  id: string;
  name: string;
  accessToken: string;
  organizationId: string;
}

function accountsFile(): string {
  return path.join(dataDir(), "accounts.json");
}

export function loadAccounts(): StoredAccount[] {
  try {
    const raw = fs.readFileSync(accountsFile(), "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a): a is StoredAccount =>
        Boolean(a) && typeof a.id === "string" && typeof a.accessToken === "string" && a.accessToken.length > 0
    );
  } catch {
    return []; // no file yet, or unreadable — start empty
  }
}

export function saveAccounts(accounts: StoredAccount[]): void {
  fs.writeFileSync(accountsFile(), JSON.stringify(accounts, null, 2), "utf8");
}

/** Env fallback account, or null when BUFFER_ACCESS_TOKEN is unset/placeholder. */
export function envAccount(): StoredAccount | null {
  const token = (process.env.BUFFER_ACCESS_TOKEN ?? "").trim();
  if (!token || token.startsWith("your_")) return null;
  return {
    id: "env-default",
    name: "Default",
    accessToken: token,
    organizationId: (process.env.BUFFER_ORGANIZATION_ID ?? "").trim(),
  };
}

/** Every account the app can post through: saved UI accounts first, else the
 *  env fallback (README: env vars act as "Default" while nothing is saved). */
export function listAccounts(): StoredAccount[] {
  const saved = loadAccounts();
  if (saved.length > 0) return saved;
  const fallback = envAccount();
  return fallback ? [fallback] : [];
}

/**
 * Full account (with its real token) for SERVER-SIDE use only — never send this
 * to the browser (use `toPublic`). Returns null when the id is unknown, e.g. a
 * target referring to an account the user deleted.
 */
export async function getAccount(id: string): Promise<StoredAccount | null> {
  return listAccounts().find((a) => a.id === id) ?? null;
}

/** Shape handed to the browser — no token field exists on purpose. */
export function toPublic(acc: StoredAccount): PublicAccount {
  return { id: acc.id, name: acc.name, organizationId: acc.organizationId };
}

export function newAccountId(): string {
  return randomUUID();
}
