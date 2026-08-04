import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  CSRF_COOKIE,
  generateCsrfCookieValue,
  verifyCsrfCookieValue,
} from "@/lib/auth/csrf";

// Ensures every request carries a validly-signed CSRF cookie before any page
// renders, so client code always has a fresh token to echo back on mutating
// requests. Runs on the Edge runtime — csrf.ts only uses Web Crypto so this
// works without node:crypto.
export async function middleware(request: NextRequest) {
  const response = NextResponse.next();

  const existing = request.cookies.get(CSRF_COOKIE)?.value;
  const validToken = existing ? await verifyCsrfCookieValue(existing) : null;

  if (!validToken) {
    const value = await generateCsrfCookieValue();
    response.cookies.set(CSRF_COOKIE, value, {
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
