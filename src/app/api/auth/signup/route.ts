import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyCsrf } from "@/lib/auth/csrf";
import { signupSchema } from "@/lib/auth/schemas";
import { hashPassword } from "@/lib/auth/password";

// Never reveals whether the email was already registered: on success (new
// account created) and on "already registered" (silently skipped), the
// response is identical, and neither logs the caller in — both cases send
// the user to /login next, so there's no observable difference either way.
export async function POST(request: Request) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 }
    );
  }

  const { email, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (!existing) {
    const passwordHash = await hashPassword(password);
    await prisma.user.create({ data: { email, passwordHash } });
  }

  return NextResponse.json({
    message: "If that email can be used to create an account, it now has one. Log in to continue.",
  });
}
