import "server-only";
import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/db";

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// The plaintext token is only ever held in memory long enough to email it —
// only its hash is persisted, so a database read can't produce a usable
// reset link.
export async function createResetToken(userId: string): Promise<string> {
  await prisma.passwordResetToken.deleteMany({
    where: { userId, usedAt: null },
  });

  const token = randomBytes(32).toString("hex");
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  return token;
}

// Validates and burns a token in one step (single-use). Returns the
// associated userId, or null if the token is missing/expired/already used.
export async function consumeResetToken(token: string): Promise<string | null> {
  const tokenHash = hashToken(token);
  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
  });

  if (!record || record.usedAt || record.expiresAt < new Date()) return null;

  await prisma.passwordResetToken.update({
    where: { id: record.id },
    data: { usedAt: new Date() },
  });

  return record.userId;
}
