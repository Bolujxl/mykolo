import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requireAuthApi } from "@/lib/auth/guards";
import { entrySchema } from "@/lib/auth/schemas";

export async function POST(request: Request) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }

  const auth = await requireAuthApi();
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsed = entrySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", message: parsed.error.issues[0]?.message ?? "Invalid input." },
      { status: 400 }
    );
  }

  const { amount, note, date } = parsed.data;
  const entry = await prisma.entry.create({
    data: {
      userId: auth.userId,
      amountCents: Math.round(amount * 100),
      note: note || null,
      date,
    },
  });

  return NextResponse.json(
    {
      entry: {
        id: entry.id,
        amountCents: entry.amountCents,
        note: entry.note,
        date: entry.date,
      },
    },
    { status: 201 }
  );
}
