import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { verifyCsrf } from "@/lib/auth/csrf";
import { loginSchema } from "@/lib/auth/schemas";
import { verifyPassword } from "@/lib/auth/password";
import { getSession } from "@/lib/auth/session";
import { createSessionRecord } from "@/lib/auth/sessions";
import {
  isAccountLocked,
  lockoutMinutesRemaining,
  recordFailedLogin,
  clearFailedLogins,
} from "@/lib/auth/lockout";
import { loginRateLimiter, getClientIp } from "@/lib/auth/rate-limit";

// Precomputed once so a lookup for a nonexistent email still pays the cost
// of a bcrypt compare — keeps response timing from leaking whether the
// email exists in the system.
const DUMMY_HASH = bcrypt.hashSync("kolovault-timing-normalization", 12);

const GENERIC_INVALID = NextResponse.json(
  { error: "invalid_credentials", message: "Invalid email or password." },
  { status: 401 }
);

export async function POST(request: Request) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }

  const ip = getClientIp(request);
  const rateLimit = await loginRateLimiter.check(ip);
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many login attempts. Try again later." },
      { status: 429 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: "Invalid email or password." },
      { status: 400 }
    );
  }

  const { email, password } = parsed.data;
  const user = await prisma.user.findUnique({ where: { email } });

  const passwordMatches = await verifyPassword(
    password,
    user?.passwordHash ?? DUMMY_HASH
  );

  if (!user || !passwordMatches) {
    if (user) await recordFailedLogin(user.id);
    return GENERIC_INVALID;
  }

  // Only reveal lockout state once the password is known to be correct —
  // otherwise an attacker guessing emails could use the lockout message
  // itself as an oracle for which addresses have accounts.
  if (isAccountLocked(user)) {
    return NextResponse.json(
      {
        error: "account_locked",
        message: `Too many failed attempts. Your account is locked for ${lockoutMinutesRemaining(
          user
        )} more minute(s), or you can reset your password to unlock it immediately.`,
      },
      { status: 403 }
    );
  }

  await clearFailedLogins(user.id);

  const sessionRecord = await createSessionRecord(user.id);
  const session = await getSession();
  session.userId = user.id;
  session.sessionId = sessionRecord.id;
  await session.save();

  return NextResponse.json({ message: "Logged in." });
}
