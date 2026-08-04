import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requestResetSchema } from "@/lib/auth/schemas";
import { createResetToken } from "@/lib/auth/reset-token";
import { sendPasswordResetEmail } from "@/lib/email";
import { resetRequestRateLimiter, getClientIp } from "@/lib/auth/rate-limit";

const GENERIC_MESSAGE = {
  message: "If that email has an account, a password reset link has been sent.",
};

// Always returns the same response whether or not the email is registered —
// only the side effect (sending an email) differs, and that happens
// entirely server-side where the caller can't observe it.
export async function POST(request: Request) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }

  const ip = getClientIp(request);
  const rateLimit = await resetRequestRateLimiter.check(ip);
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "Too many requests. Try again later." },
      { status: 429 }
    );
  }

  const body = await request.json().catch(() => null);
  const parsed = requestResetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(GENERIC_MESSAGE);
  }

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (user) {
    const token = await createResetToken(user.id);
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
    const resetUrl = `${appUrl}/reset-password/${token}`;
    await sendPasswordResetEmail(user.email, resetUrl);
  }

  return NextResponse.json(GENERIC_MESSAGE);
}
