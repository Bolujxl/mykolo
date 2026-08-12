import { getPasswordStrength } from "@/lib/password-strength";

// Red while the password falls short of the server's rule, success green
// once it meets it — a distinct role from gold, which stays reserved for
// money-growth moments elsewhere in the app.
export function PasswordStrengthMeter({ password }: { password: string }) {
  const { score, message, meetsMinimum } = getPasswordStrength(password);
  const fillColor = meetsMinimum ? "bg-success" : "bg-error";
  const textColor = meetsMinimum ? "text-success" : "text-error";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex gap-1" role="presentation">
        {[1, 2, 3, 4].map((segment) => (
          <div
            key={segment}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-outline/30"
          >
            <div
              className={`h-full rounded-full ${fillColor} transition-opacity duration-300 ${
                segment <= score ? "opacity-100" : "opacity-0"
              }`}
            />
          </div>
        ))}
      </div>
      <p className={`text-xs ${password.length === 0 ? "text-on-surface-variant" : textColor}`}>
        {password.length === 0
          ? "At least 12 characters, mixing 3 of: lowercase, uppercase, numbers, symbols."
          : message}
      </p>
    </div>
  );
}
