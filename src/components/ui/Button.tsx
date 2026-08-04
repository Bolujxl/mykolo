import { type ButtonHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
};

const VARIANTS: Record<string, string> = {
  primary: "bg-primary text-on-primary hover:opacity-90",
  ghost: "border border-outline text-on-background bg-transparent hover:bg-surface-variant",
  danger: "border border-error text-error bg-transparent hover:bg-error hover:text-on-error",
};

export function Button({
  variant = "primary",
  className,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${className ?? ""}`}
      disabled={disabled}
      {...rest}
    />
  );
}
