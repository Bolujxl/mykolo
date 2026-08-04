import { NextResponse } from "next/server";
import { verifyCsrf } from "@/lib/auth/csrf";
import { getSession } from "@/lib/auth/session";
import { revokeSessionRecord } from "@/lib/auth/sessions";

export async function POST(request: Request) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }

  const session = await getSession();
  if (session.sessionId) {
    await revokeSessionRecord(session.sessionId);
  }
  session.destroy();

  return NextResponse.json({ message: "Logged out." });
}
