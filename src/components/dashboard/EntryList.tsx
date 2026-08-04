import { formatCurrency } from "@/lib/api-client";
import { DeleteEntryButton } from "./DeleteEntryButton";

type Entry = {
  id: string;
  amountCents: number;
  note: string | null;
  date: Date;
};

export function EntryList({ entries }: { entries: Entry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-sm text-on-surface-variant">
        No entries yet — add your first coin above.
      </p>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-outline">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-center justify-between gap-4 py-3">
          <div className="flex flex-col">
            <span className="font-mono font-medium text-on-background">
              {formatCurrency(entry.amountCents)}
            </span>
            <span className="text-sm text-on-surface-variant">
              {entry.date.toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
              {entry.note ? ` · ${entry.note}` : ""}
            </span>
          </div>
          <DeleteEntryButton id={entry.id} />
        </li>
      ))}
    </ul>
  );
}
