import "server-only";
import { cookies } from "next/headers";
import { getIronSession, type IronSession } from "iron-session";

export interface SessionData {
  userId?: string;
  // Row id in the Session registry table (lib/auth/sessions.ts). Every
  // authenticated request re-checks that this row still exists, which is
  // what makes "log out everywhere" an actual remote revocation instead of
  // just clearing the local cookie.
  sessionId?: string;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  throw new Error(
    "SESSION_SECRET must be set to a random string of at least 32 characters."
  );
}

export const sessionOptions = {
  password: process.env.SESSION_SECRET,
  cookieName: "koloclay_session",
  ttl: SESSION_TTL_SECONDS,
  cookieOptions: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: SESSION_TTL_SECONDS,
    path: "/",
  },
};

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}
