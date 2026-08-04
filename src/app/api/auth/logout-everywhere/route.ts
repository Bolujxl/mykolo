import { NextResponse } from "next/server";
import { verifyCsrf } from "@/lib/auth/csrf";
import { getSession } from "@/lib/auth/session";
import { requireAuthApi } from "@/lib/auth/guards";
import { revokeAllSessionRecords } from "@/lib/auth/sessions";

// Revokes every Session registry row for the user — not just the local
// cookie — so every device/browser that was logged in is actually signed
// out on their next request.
export async function POST(request: Request) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }

  const auth = await requireAuthApi();
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  await revokeAllSessionRecords(auth.userId);

  const session = await getSession();
  session.destroy();

  return NextResponse.json({ message: "Logged out everywhere." });
}
