import { type NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Session refresh + route protection.
 *
 * Runs on every request so Supabase's auth cookie is kept fresh. Pages that
 * need a signed-in user are redirected to /login; API routes get a 401 JSON
 * body instead, because redirecting a fetch() to an HTML login page is exactly
 * what produced the old `Unexpected token '<'` confusion.
 */ 
const PUBLIC_PAGES = ["/login", "/signup", "/auth/callback"];

/**
 * Endpoints that must stay reachable with NO session. The Paystack webhook
 * calls in from Paystack's servers, which obviously have no Supabase cookie —
 * gating it would mean payments silently never arrive. It authenticates itself
 * by re-verifying every transaction with Paystack's API (see the route), so it
 * needs no cookie and must never trust the request body on its own.
 */
const PUBLIC_API = ["/api/billing/webhook"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Supabase not configured yet — let the app boot so the user can see the
  // setup error instead of a redirect loop.
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates the JWT with Supabase; this is what refreshes it.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublic = PUBLIC_PAGES.some((p) => pathname.startsWith(p));
  const isApi = pathname.startsWith("/api");
  const isPublicApi = PUBLIC_API.some((p) => pathname.startsWith(p));

  if (!user && !isPublic && !isPublicApi) {
    if (isApi) {
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
  if (user && (pathname === "/login" || pathname === "/signup")) {
    const redirect = request.nextUrl.clone();
    redirect.pathname = "/";
    redirect.search = "";
    return NextResponse.redirect(redirect);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Everything except Next's build output, static files and image assets.
     * Keeping it broad means a newly added page is protected by default.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};