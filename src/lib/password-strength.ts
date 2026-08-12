// Mirrors the server-side rule in lib/auth/password.ts: 12+ characters and
// at least 3 of lowercase/uppercase/digit/symbol. Purely a UX aid — the
// server always re-validates, this never replaces that check.
export type PasswordStrength = {
  score: 0 | 1 | 2 | 3 | 4;
  message: string;
  meetsMinimum: boolean;
};

const REQUIRED_LENGTH = 12;
const REQUIRED_VARIETY = 3;

const CATEGORIES = [
  { name: "lowercase letter", test: /[a-z]/ },
  { name: "uppercase letter", test: /[A-Z]/ },
  { name: "number", test: /[0-9]/ },
  { name: "symbol", test: /[^a-zA-Z0-9]/ },
];

export function getPasswordStrength(password: string): PasswordStrength {
  if (!password) return { score: 0, message: "", meetsMinimum: false };

  const missing = CATEGORIES.filter((c) => !c.test.test(password));
  const variety = CATEGORIES.length - missing.length;

  const meetsMinimum = password.length >= REQUIRED_LENGTH && variety >= REQUIRED_VARIETY;
  const lengthRemaining = Math.max(0, REQUIRED_LENGTH - password.length);
  const varietyRemaining = Math.max(0, REQUIRED_VARIETY - variety);

  // The bar fills completely exactly when the password meets the server's
  // actual rule — that's the real success state, not a bonus tier, so the
  // last segment shouldn't sit unused for a password that's already valid.
  // Below that, fill gradually based on progress toward length + variety.
  let score: PasswordStrength["score"];
  if (meetsMinimum) {
    score = 4;
  } else {
    const lengthProgress = Math.min(1, password.length / REQUIRED_LENGTH);
    const varietyProgress = Math.min(1, variety / REQUIRED_VARIETY);
    const combined = (lengthProgress + varietyProgress) / 2;
    score = Math.max(1, Math.min(3, Math.ceil(combined * 3))) as PasswordStrength["score"];
  }

  let message: string;
  if (meetsMinimum) {
    const isStrong = password.length >= 16 && variety === 4;
    message = isStrong ? "Strong" : "Meets requirements";
  } else {
    const needs: string[] = [];
    if (lengthRemaining > 0) {
      needs.push(`${lengthRemaining} more character${lengthRemaining === 1 ? "" : "s"}`);
    }
    if (varietyRemaining > 0) {
      const suggestions = missing.slice(0, varietyRemaining).map((c) => c.name);
      needs.push(
        `${varietyRemaining} more character type${varietyRemaining === 1 ? "" : "s"} (${suggestions.join(", ")})`
      );
    }
    message = `Add ${needs.join(" and ")}`;
  }

  return { score, message, meetsMinimum };
}
