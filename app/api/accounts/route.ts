import { NextResponse } from "next/server";
import {
  loadAccounts,
  saveAccounts,
  listAccounts,
  newAccountId,
  toPublic,
} from "../../../lib/accounts";
import { withAuth } from "../../../lib/withAuth";
import { resolveBufferAccount } from "../../../lib/buffer";

/**
 * Buffer account registry — what the "Buffer accounts" panel talks to.
 *
 * GET    → list this user's saved accounts (tokens NEVER leave the server)
 * POST   → validate a pasted personal API key live against Buffer, resolve its
 *          organization, and persist it to data/users/<userId>/accounts.json
 * DELETE → remove one of this user's saved accounts (the env-var "Default"
 *          can't be deleted here)
 *
 * These are real credentials that can post to someone's social accounts, so
 * every account here belongs to ONE user and is stored in their own file.
 */

export const GET = withAuth(async () => {
  return NextResponse.json({ accounts: listAccounts().map(toPublic) });
});

export const POST = withAuth(async (req: Request) => {
  let body: { name?: string; accessToken?: string; organizationId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = (body.name ?? "").trim();
  const token = (body.accessToken ?? "").trim();
  const organizationId = (body.organizationId ?? "").trim();

  if (!name) return NextResponse.json({ error: "Display name is required." }, { status: 400 });
  if (!token) return NextResponse.json({ error: "Buffer API key is required." }, { status: 400 });

  const existing = loadAccounts();
  if (existing.some((a) => a.accessToken === token)) {
    return NextResponse.json({ error: "This API key is already saved." }, { status: 400 });
  }

  try {
    // Every addition is validated live against Buffer, so a revoked key or
    // wrong org ID fails right here with a real reason instead of causing
    // mysterious channel-loading errors later.
    const resolved = await resolveBufferAccount(token, organizationId || undefined);
    const account = {
      id: newAccountId(),
      name,
      accessToken: token,
      organizationId: resolved.organizationId,
    };
    saveAccounts([...existing, account]);
    return NextResponse.json({ account: toPublic(account) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Buffer rejected this API key." },
      { status: 400 }
    );
  }
});

export const DELETE = withAuth(async (req: Request) => {
  let body: { id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const id = (body.id ?? "").trim();
  if (!id) return NextResponse.json({ error: "Account id is required." }, { status: 400 });
  if (id === "env-default") {
    return NextResponse.json(
      { error: 'The "Default" account comes from BUFFER_ACCESS_TOKEN in your environment — unset it there instead.' },
      { status: 400 }
    );
  }

  const existing = loadAccounts();
  const next = existing.filter((a) => a.id !== id);
  if (next.length === existing.length) {
    return NextResponse.json({ error: "Account not found." }, { status: 404 });
  }
  saveAccounts(next);
  return NextResponse.json({ ok: true });
});
