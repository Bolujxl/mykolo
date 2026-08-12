import { type InputHTMLAttributes } from "react";

type TextFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
};

export function TextField({ label, error, id, className, ...rest }: TextFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-on-background">
        {label}
      </label>
      <input
        id={id}
        className={`rounded-lg border border-outline/50 bg-surface-variant px-3 py-2.5 text-on-background placeholder:text-on-surface-variant focus:outline-none focus:ring-2 focus:ring-primary ${className ?? ""}`}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-error` : undefined}
        {...rest}
      />
      {error && (
        <p id={`${id}-error`} className="text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}
