import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyCsrf } from "@/lib/auth/csrf";
import { confirmResetSchema } from "@/lib/auth/schemas";
import { consumeResetToken } from "@/lib/auth/reset-token";
import { hashPassword } from "@/lib/auth/password";
import { clearFailedLogins } from "@/lib/auth/lockout";
import { revokeAllSessionRecords } from "@/lib/auth/sessions";

export async function POST(request: Request) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = confirmResetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 }
    );
  }

  const { token, password } = parsed.data;
  const userId = await consumeResetToken(token);
  if (!userId) {
    return NextResponse.json(
      { error: "invalid_token", message: "This reset link is invalid or has expired." },
      { status: 400 }
    );
  }

  const passwordHash = await hashPassword(password);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });

  // Resetting your password is the account's unlock path, and — since
  // whoever holds a working reset link controls the mailbox — a natural
  // point to kill any sessions an attacker may have been riding on.
  await clearFailedLogins(userId);
  await revokeAllSessionRecords(userId);

  return NextResponse.json({ message: "Password updated. You can now log in." });
}
