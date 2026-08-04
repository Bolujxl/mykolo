import "server-only";

// Signed double-submit cookie CSRF protection. Runs in both Middleware
// (Edge runtime) and Route Handlers (Node runtime), so this only uses the
// Web Crypto API (`crypto.subtle`, `crypto.randomUUID`) — no `node:crypto`.
//
// The cookie is intentionally NOT httpOnly: client JS must be able to read
// the token to echo it back as a header on mutating requests. What makes
// this safe is the HMAC signature — a cross-site attacker can make the
// victim's browser *send* the cookie, but can't *read* its value (same-
// origin policy), so they can't produce a matching header even if they can
// trigger a cross-site POST.

export const CSRF_COOKIE = "koloclay_csrf";
export const CSRF_HEADER = "x-csrf-token";

function getCsrfSecret(): string {
  const secret = process.env.CSRF_SECRET ?? process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("CSRF_SECRET or SESSION_SECRET must be set.");
  }
  return secret;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getCsrfSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sign(value: string): Promise<string> {
  const key = await hmacKey();
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );
  return toHex(signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function generateCsrfCookieValue(): Promise<string> {
  const token = crypto.randomUUID().replace(/-/g, "");
  const signature = await sign(token);
  return `${token}.${signature}`;
}

// Returns the token portion if the cookie's signature is valid, else null.
export async function verifyCsrfCookieValue(
  cookieValue: string
): Promise<string | null> {
  const [token, signature] = cookieValue.split(".");
  if (!token || !signature) return null;
  const expected = await sign(token);
  return timingSafeEqual(expected, signature) ? token : null;
}

function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}

// For use in Route Handlers on every mutating request (POST/PUT/PATCH/DELETE).
export async function verifyCsrf(request: Request): Promise<boolean> {
  const cookieValue = readCookie(request.headers.get("cookie") ?? "", CSRF_COOKIE);
  const headerToken = request.headers.get(CSRF_HEADER);
  if (!cookieValue || !headerToken) return false;

  const validToken = await verifyCsrfCookieValue(cookieValue);
  if (!validToken) return false;

  return timingSafeEqual(validToken, headerToken);
}
