import { NextResponse } from "next/server";
import {
  findUserByEmail,
  verifyPassword,
  createSession,
  setSessionCookie,
} from "../../../../lib/authContext";

/**
 * Email + password sign-in for the app-owned auth system.
 *
 * Body: { email, password }. Verifies the bcrypt hash in `public.users`,
 * mints a row in `sessions`, and sets the httpOnly `l2s_session` cookie.
 * Always the same 401 for unknown email vs wrong password, so the endpoint
 * can't be used to enumerate accounts.
 */
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    let body: { email?: string; password?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const email = (body.email ?? "").trim();
    const password = body.password ?? "";
    if (!email || !password) {
      return NextResponse.json({ error: "Enter your email and password." }, { status: 400 });
    }

    const user = await findUserByEmail(email);
    if (!user || !(await verifyPassword(user, password))) {
      return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
    }

    const raw = await createSession(user.id);
    setSessionCookie(raw);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message ?? "Could not sign in." },
      { status: err?.status ?? 500 }
    );
  }
}