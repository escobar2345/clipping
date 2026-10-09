import { type NextRequest, NextResponse } from "next/server";

/**
 * Route protection.
 *
 * Auth is app-owned: a `l2s_session` httpOnly cookie holding a random token
 * kept in the Postgres `sessions` table. Middleware only checks for its
 * PRESENCE (cheap edge check); every API route revalidates it against the
 * database (see lib/authContext.ts), so a stolen/expired token still fails.
 *
 * Pages that need a signed-in user are redirected to /login; API routes get a
 * 401 JSON body instead, because redirecting a fetch() to an HTML login page
 * is exactly what produced the old `Unexpected token '<'` confusion.
 */
const PUBLIC_PAGES = ["/login", "/signup"];

function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Endpoints that must stay reachable with NO session: login/signup (the user
 * has no cookie yet), sign-out (must always succeed), the Paystack webhook
 * (Paystack's servers have no cookie — it authenticates itself by re-verifying
 * every transaction with Paystack's API), and health checks.
 */
const PUBLIC_API = [
  "/api/auth/login",
  "/api/auth/signup",
  "/api/auth/signout",
  "/api/billing/webhook",
  "/api/health",
  // Remotion's headless browser has no user cookie. The path is constrained
  // to a UUID folder and a video filename by the media route itself.
  "/api/media/uploads",
];

/** Static media (source videos + rendered clips) stays reachable WITHOUT a
 *  cookie, by design:
 *  - Remotion's render proxy fetches the source mp4 from localhost with no
 *    session (a redirect here feeds it the HTML login page and the render
 *    dies with "Invalid data found when processing input"),
 *  - the Buffer/tunnel flow and social platforms fetch the OUTPUT URLs
 *    server-side too.
 *  The file LISTINGS still go through the protected /api/uploads and
 *  /api/renders routes — only the bytes are public. */
const PUBLIC_MEDIA = ["/uploads/", "/renders/"];

function isPublicMedia(pathname: string): boolean {
  return PUBLIC_MEDIA.some((p) => pathname.startsWith(p));
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const response = NextResponse.next({ request });

  // Presence check only — cheap at the edge. API routes + pages revalidate
  // the token against the Postgres sessions table (lib/authContext.ts).
  const hasSession = Boolean(request.cookies.get("l2s_session")?.value);

  // Media bytes are public (see PUBLIC_MEDIA) — skip ALL auth logic for them,
  // including the signed-in login-page bounce.
  if (isPublicMedia(pathname)) {
    return response;
  }

  const isPublic = isPublicPage(pathname);
  const isPublicApi = PUBLIC_API.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  if (!hasSession && !isPublic && !isPublicApi) {
    if (pathname.startsWith("/api")) {
      // Keep the API contract JSON-only — never redirect a fetch to HTML.
      return NextResponse.json(
        { error: "You must be signed in to use this endpoint." },
        { status: 401 }
      );
    }
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/login";
    redirect.searchParams.set("next", pathname);
    return NextResponse.redirect(redirect);
  }

  // Already signed in but sitting on the login/signup page → go to the app.
  if (hasSession && (pathname === "/login" || pathname === "/signup")) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/";
    redirect.search = "";
    return NextResponse.redirect(redirect);
  }

  return response;
}

// Runs on everything except Next's build output — new pages are protected by default.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};