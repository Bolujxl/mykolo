import { Logo } from "./Logo";

export function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-1 items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Logo size={40} />
          <div>
            <h1 className="text-xl font-semibold text-on-background">{title}</h1>
            {subtitle && (
              <p className="mt-1 text-sm text-on-surface-variant">{subtitle}</p>
            )}
          </div>
        </div>
        <div className="rounded-2xl border border-outline bg-surface p-6 shadow-sm">
          {children}
        </div>
      </div>
    </div>
  );
}
