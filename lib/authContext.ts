import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "./supabase/server";
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
  user: User;
  userId: string;
  email: string;
}

/**
 * The signed-in user, or null. Never returns a user for an expired/unverified
 * session — `getUser()` revalidates the JWT with Supabase rather than trusting a
 * cookie value. `cache()` dedupes it within one render pass.
 */
export const getAuthContext = cache(async (): Promise<AuthContext | null> => {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;
  return { user, userId: user.id, email: user.email ?? "" };
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