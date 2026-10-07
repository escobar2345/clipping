import { cache } from "react";
import { cookies } from "next/headers";
import { randomBytes, createHash } from "crypto";
import bcrypt from "bcryptjs";
import { getPool } from "./db";
import { runAsUser } from "./userPaths";

/** Thrown when a request has no valid session; routes turn it into a 401. */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(message = "You must be signed in.") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** Who is making this request. Directories are resolved per-user, not stored here. */
export interface AuthContext {
  userId: string;
  email: string;
  fullName: string;
}

/** Name of the session cookie. httpOnly — JS in the browser can never read it. */
export const SESSION_COOKIE = "l2s_session";

const SESSION_DAYS = 30;

/** sha256 of the raw token — what we store, so a DB leak can't mint sessions. */
function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function sessionCookieOptions() {
  const secure = process.env.NODE_ENV === "production";
  return {
    httpOnly: true as const,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  };
}

export interface DbUser {
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
}

export async function findUserByEmail(email: string): Promise<DbUser | null> {
  const { rows } = await getPool().query<DbUser>(
    "select id, email, full_name, password_hash from public.users where lower(email) = lower($1) limit 1",
    [email.trim()]
  );
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<DbUser | null> {
  const { rows } = await getPool().query<DbUser>(
    "select id, email, full_name, password_hash from public.users where id = $1 limit 1",
    [id]
  );
  return rows[0] ?? null;
}

/**
 * Creates an account with a bcrypt-hashed password. Throws a friendly error
 * on duplicate email (unique violation, SQLSTATE 23505).
 */
export async function createUser(args: {
  email: string;
  password: string;
  fullName?: string;
}): Promise<DbUser> {
  const email = args.email.trim();
  const hash = await bcrypt.hash(args.password, 10);
  try {
    const { rows } = await getPool().query<DbUser>(
      "insert into public.users (email, password_hash, full_name) values ($1, $2, $3) returning id, email, full_name, password_hash",
      [email, hash, (args.fullName ?? "").trim()]
    );
    const user = rows[0];
    if (!user) throw new Error("Could not create the account.");
    return user;
  } catch (err: any) {
    if (err?.code === "23505") {
      throw new Error("An account with that email already exists.");
    }
    throw err;
  }
}

/** bcrypt comparison; never throws — a bad hash just fails the check. */
export async function verifyPassword(user: DbUser, password: string): Promise<boolean> {
  if (!user.password_hash) return false;
  try {
    return await bcrypt.compare(password, user.password_hash);
  } catch {
    return false;
  }
}

/** Mints a session row + returns the raw token to set as the cookie. */
export async function createSession(userId: string): Promise<string> {
  const raw = randomBytes(32).toString("hex");
  await getPool().query(
    "insert into public.sessions (id, user_id, expires_at) values ($1, $2, now() + ($3 || ' days')::interval)",
    [hashToken(raw), userId, String(SESSION_DAYS)]
  );
  return raw;
}

export function setSessionCookie(rawToken: string): void {
  cookies().set(SESSION_COOKIE, rawToken, sessionCookieOptions());
}

export function clearSessionCookie(): void {
  try {
    cookies().set(SESSION_COOKIE, "", { ...sessionCookieOptions(), maxAge: 0 });
  } catch {
    /* middleware clears it instead on edge paths */
  }
}

function readSessionToken(): string | null {
  try {
    return cookies().get(SESSION_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Session row -> user, with sliding expiry. Null when missing/expired/unknown.
 *
 * sessions.id IS the sha256 hash of the raw token, so a single indexed lookup
 * both finds the row and authenticates it (a hash preimage can't be forged);
 * equality on the digest needs no timingSafeEqual.
 */
async function sessionToUser(rawToken: string | null): Promise<DbUser | null> {
  if (!rawToken || rawToken.length < 32) return null;
  const pool = getPool();
  const { rows } = await pool.query<{ user_id: string }>(
    "select user_id from public.sessions where id = $1 and expires_at > now() limit 1",
    [hashToken(rawToken)]
  );
  const uid = rows[0]?.user_id;
  if (!uid) return null;
  await pool
    .query("update public.sessions set expires_at = now() + ($2 || ' days')::interval where id = $1", [
      hashToken(rawToken),
      String(SESSION_DAYS),
    ])
    .catch(() => undefined);
  return findUserById(uid);
}

/**
 * The signed-in user, or null. `cache()` dedupes it within one render pass.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const token = readSessionToken();
  let user: DbUser | null = null;
  try {
    user = await sessionToUser(token);
  } catch {
    user = null;
  }
  if (!user) return null;
  return { userId: user.id, email: user.email, fullName: user.full_name ?? "" };
});

/** Same as getAuthContext but throws UnauthorizedError when signed out. */
export async function requireAuth(): Promise<AuthContext> {
  const ctx = await getAuthContext();
  if (!ctx) throw new UnauthorizedError();
  return ctx;
}

/**
 * Runs `fn` as the signed-in user, so per-user storage (lib/userPaths.ts)
 * resolves to their directories. Route handlers use this — directly or through
 * withAuth() — so nothing can accidentally read the shared/global store.
 */
export async function asCurrentUser<T>(fn: () => T | Promise<T>): Promise<T> {
  const ctx = await requireAuth();
  return runAsUser(ctx.userId, fn);
}

/** Destroys the current session (sign-out). Never throws. */
export async function destroySession(): Promise<void> {
  const token = readSessionToken();
  try {
    if (token) {
      await getPool().query("delete from public.sessions where id = $1", [hashToken(token)]);
    }
  } catch {
    /* sign-out must succeed even if the DB hiccups */
  }
  clearSessionCookie();
}