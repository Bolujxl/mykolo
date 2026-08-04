import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requireAuthApi } from "@/lib/auth/guards";
import { goalSchema } from "@/lib/auth/schemas";

export async function POST(request: Request) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }

  const auth = await requireAuthApi();
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = goalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 }
    );
  }

  const { goalAmount } = parsed.data;
  await prisma.user.update({
    where: { id: auth.userId },
    data: {
      goalAmountCents: goalAmount === null ? null : Math.round(goalAmount * 100),
    },
  });

  return NextResponse.json({ message: "Goal updated." });
}
