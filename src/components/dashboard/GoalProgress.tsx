import { formatCurrency } from "@/lib/api-client";

export function GoalProgress({
  totalCents,
  goalCents,
}: {
  totalCents: number;
  goalCents: number | null;
}) {
  if (!goalCents) return null;

  const pct = Math.min(100, Math.round((totalCents / goalCents) * 100));
  const reached = totalCents >= goalCents;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-on-surface-variant">Goal: {formatCurrency(goalCents)}</span>
        <span className="font-mono text-on-surface-variant">{pct}%</span>
      </div>
      <div className="h-3 w-full overflow-hidden rounded-full bg-surface-variant">
        <div
          className="h-full rounded-full bg-secondary transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      {reached && <p className="text-sm font-medium text-secondary">Goal reached.</p>}
    </div>
  );
}
