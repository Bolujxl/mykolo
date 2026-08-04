import "server-only";
import { redirect } from "next/navigation";
import { getSession } from "./session";
import { isSessionRecordValid } from "./sessions";

async function getValidatedSession() {
  const session = await getSession();
  if (!session.userId || !session.sessionId) return null;

  const valid = await isSessionRecordValid(session.sessionId, session.userId);
  if (!valid) {
    // Cookie mutation is only allowed from Route Handlers/Server Actions —
    // this no-ops harmlessly when called from a Server Component render,
    // where the stale cookie is left in place but inert (no registry row
    // backs it, so it will keep failing this same check).
    try {
      session.destroy();
    } catch {
      // ignore — not in a context that allows cookie mutation
    }
    return null;
  }

  return { session, userId: session.userId };
}

// For Server Components / pages: redirects to /login when not authenticated.
export async function requireAuth() {
  const result = await getValidatedSession();
  if (!result) redirect("/login");
  return result;
}

// For Server Components / pages: redirects to /dashboard when already
// authenticated (login/signup pages shouldn't be reachable while logged in).
export async function requireGuest() {
  const result = await getValidatedSession();
  if (result) redirect("/dashboard");
}

// For Route Handlers: returns null instead of redirecting so the caller can
// respond with a JSON 401.
export async function requireAuthApi() {
  return getValidatedSession();
}
