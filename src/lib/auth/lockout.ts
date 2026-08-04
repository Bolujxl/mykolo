import "server-only";
import { prisma } from "@/lib/db";
import type { User } from "@prisma/client";

export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_WINDOW_MS = 60 * 60 * 1000; // failures counted per rolling hour
export const LOCKOUT_DURATION_MS = 60 * 60 * 1000; // account stays locked for an hour

export function isAccountLocked(user: Pick<User, "lockedUntil">): boolean {
  return !!user.lockedUntil && user.lockedUntil.getTime() > Date.now();
}

export function lockoutMinutesRemaining(user: Pick<User, "lockedUntil">): number {
  if (!user.lockedUntil) return 0;
  return Math.max(0, Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000));
}

// Called on every failed login. Counts failures in a rolling window; once
// the count reaches the threshold within that window, locks the account for
// LOCKOUT_DURATION_MS. The window resets itself once it goes stale, so a
// locked account also unlocks automatically without any extra cleanup job.
export async function recordFailedLogin(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  const now = new Date();
  const windowExpired =
    !user.firstFailedLoginAt ||
    now.getTime() - user.firstFailedLoginAt.getTime() > LOCKOUT_WINDOW_MS;

  const nextCount = windowExpired ? 1 : user.failedLoginCount + 1;
  const nextFirstFailedLoginAt = windowExpired ? now : user.firstFailedLoginAt;
  const shouldLock = nextCount >= LOCKOUT_THRESHOLD;

  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginCount: nextCount,
      firstFailedLoginAt: nextFirstFailedLoginAt,
      lockedUntil: shouldLock
        ? new Date(now.getTime() + LOCKOUT_DURATION_MS)
        : user.lockedUntil,
    },
  });
}

// Called on successful login and on successful password reset — resetting
// your password is the clear, immediate unlock path communicated to users
// who are locked out (the alternative is just waiting out the hour).
export async function clearFailedLogins(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, firstFailedLoginAt: null, lockedUntil: null },
  });
}
