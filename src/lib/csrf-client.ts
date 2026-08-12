// Client-side counterpart to lib/auth/csrf.ts. Reads the (non-httpOnly)
// CSRF cookie that middleware.ts guarantees is present, so fetch calls to
// mutating routes can echo it back as a header.
const CSRF_COOKIE = "kolovault_csrf";
const CSRF_HEADER = "x-csrf-token";

export function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`)
  );
  if (!match) return null;
  const [token] = decodeURIComponent(match[1]).split(".");
  return token ?? null;
}

export function withCsrfHeaders(headers: HeadersInit = {}): HeadersInit {
  const token = getCsrfToken();
  return {
    ...headers,
    ...(token ? { [CSRF_HEADER]: token } : {}),
  };
}
