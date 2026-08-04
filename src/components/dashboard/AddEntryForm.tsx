"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api-client";

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AddEntryForm() {
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState(todayIsoDate());
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dropKey, setDropKey] = useState(0);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const amountNumber = Number(amount);
    if (!Number.isFinite(amountNumber) || amountNumber <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }

    setSubmitting(true);
    const { ok, data } = await apiFetch<{ message?: string }>("/api/entries", {
      body: { amount: amountNumber, note, date },
    });
    setSubmitting(false);

    if (!ok) {
      setError(data.message ?? "Couldn't save that entry. Try again.");
      return;
    }

    setAmount("");
    setNote("");
    setDate(todayIsoDate());
    setDropKey((k) => k + 1);
    router.refresh();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-4 rounded-2xl border border-outline bg-surface p-5"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-medium text-on-background">Drop a coin</h2>
        <span
          key={dropKey}
          className="h-3 w-3 rounded-full bg-secondary animate-coin-drop"
          aria-hidden
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <TextField
          id="amount"
          label="Amount"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0.01"
          required
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="font-mono"
        />
        <TextField
          id="date"
          label="Date"
          type="date"
          required
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      <TextField
        id="note"
        label="Note (optional)"
        type="text"
        maxLength={280}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && <p className="text-sm text-error">{error}</p>}
      <Button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : "Add entry"}
      </Button>
    </form>
  );
}
