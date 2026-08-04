import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyCsrf } from "@/lib/auth/csrf";
import { requireAuthApi } from "@/lib/auth/guards";

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!(await verifyCsrf(request))) {
    return NextResponse.json({ error: "Invalid request." }, { status: 403 });
  }

  const auth = await requireAuthApi();
  if (!auth) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const entry = await prisma.entry.findUnique({ where: { id } });
  if (!entry || entry.userId !== auth.userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  await prisma.entry.delete({ where: { id } });
  return NextResponse.json({ message: "Deleted." });
}
