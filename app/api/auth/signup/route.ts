import { NextResponse } from "next/server";
import {
  createUser,
  createSession,
  setSessionCookie,
} from "../../../../lib/authContext";

/**
 * Account creation for the app-owned auth system.
 *
 * Body: { email, password, name? }. Inserts into `public.users` with a
 * bcrypt hash, mints a `sessions` row, and signs the user in immediately —
 * there is no email-confirmation step in this setup.
 */
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    let body: { email?: string; password?: string; name?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const email = (body.email ?? "").trim();
    const password = body.password ?? "";
    if (!email || !password) {
      return NextResponse.json({ error: "Enter an email and a password." }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Use at least 8 characters for your password." },
        { status: 400 }
      );
    }

    const user = await createUser({ email, password, fullName: body.name ?? "" });
    const raw = await createSession(user.id);
    setSessionCookie(raw);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    const message = err?.message ?? "Could not create the account.";
    // Duplicate email is a client mistake, not a server fault.
    const status = /already exists/i.test(message) ? 409 : err?.status ?? 500;
    return NextResponse.json({ error: message }, { status });
  }
}