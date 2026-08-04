import "server-only";
import bcrypt from "bcryptjs";
import { z } from "zod";

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// Minimum 12 characters, and a mix of character types — not just length.
// Requires at least 3 of: lowercase, uppercase, digit, symbol.
export const passwordSchema = z
  .string()
  .min(12, "Password must be at least 12 characters long.")
  .max(256, "Password is too long.")
  .refine((value) => {
    const varietyChecks = [
      /[a-z]/.test(value),
      /[A-Z]/.test(value),
      /[0-9]/.test(value),
      /[^a-zA-Z0-9]/.test(value),
    ];
    const varietyCount = varietyChecks.filter(Boolean).length;
    return varietyCount >= 3;
  }, "Password must mix at least 3 of: lowercase, uppercase, numbers, symbols.");
