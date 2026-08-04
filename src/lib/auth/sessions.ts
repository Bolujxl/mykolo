import "server-only";
import { prisma } from "@/lib/db";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

// Session registry: the row of truth for whether a given login is still
// valid. iron-session's encrypted cookie proves who the request claims to
// be; this table is what lets us revoke that claim remotely.
export async function createSessionRecord(userId: string) {
  return prisma.session.create({
    data: {
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    },
  });
}

export async function isSessionRecordValid(
  sessionId: string,
  userId: string
): Promise<boolean> {
  const record = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!record || record.userId !== userId) return false;
  if (record.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
    return false;
  }
  return true;
}

// Regular logout: revoke only the current session.
export async function revokeSessionRecord(sessionId: string) {
  await prisma.session.delete({ where: { id: sessionId } }).catch(() => {});
}

// "Log out everywhere": revoke every session row for the user, current
// device included — the caller signs the current request out locally too.
export async function revokeAllSessionRecords(userId: string) {
  await prisma.session.deleteMany({ where: { userId } });
}
