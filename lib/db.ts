import { Pool } from "pg";

/**
 * Shared Postgres pool for the whole app.
 *
 * Connection: prefers DATABASE_URL (what the Railway Postgres addon injects),
 * falls back to the separate PG* variables (PGHOST, PGPORT, PGUSER, PGPASSWORD,
 * PGDATABASE) for local setups. Enforces SSL on Railway/production hosts;
 * local Postgres almost never has SSL, so plain PG vars skip it.
 *
 * The pool is created lazily and cached on `globalThis` so Next.js dev
 * hot-reloads don't open a new pool per reload.
 */

declare global {
  // eslint-disable-next-line no-var
  var __l2sPgPool: Pool | undefined;
}

function buildConfig() {
  const url = (process.env.DATABASE_URL ?? "").trim();
  if (url) {
    const ssl =
      /railway|render\.com|neon\.tech|amazonaws\.com/i.test(url) ||
      process.env.PGSSL === "1"
        ? { rejectUnauthorized: false }
        : undefined;
    return { connectionString: url, ssl };
  }
  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
    database: process.env.PGDATABASE || "long2short",
  };
}

export function getPool(): Pool {
  if (!globalThis.__l2sPgPool) {
    globalThis.__l2sPgPool = new Pool({
      ...buildConfig(),
      max: Number(process.env.PGPOOL_MAX || 10),
      idleTimeoutMillis: 30_000,
    });
  }
  return globalThis.__l2sPgPool;
}

/**
 * Is Postgres reachable right now? Used by /api/health checks. Returns the
 * error message when not, so callers show actionable text instead of guessing.
 */
export async function checkDatabase(): Promise<{ ok: boolean; error?: string }> {
  if (!process.env.DATABASE_URL && !process.env.PGHOST) {
    return { ok: false, error: "DATABASE_URL is not set." };
  }
  try {
    await getPool().query("select 1");
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "Could not reach Postgres." };
  }
}
