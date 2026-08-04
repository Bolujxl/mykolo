"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api-client";

export function GoalForm({ initialGoalCents }: { initialGoalCents: number | null }) {
  const router = useRouter();
  const [goal, setGoal] = useState(
    initialGoalCents ? (initialGoalCents / 100).toString() : ""
  );
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const goalAmount = goal.trim() === "" ? null : Number(goal);
    const { ok, data } = await apiFetch<{ message?: string }>("/api/goal", {
      body: { goalAmount },
    });

    setSubmitting(false);

    if (!ok) {
      setError(data.message ?? "Couldn't update your goal. Try again.");
      return;
    }

    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <TextField
        id="goal"
        label="Savings goal"
        type="number"
        inputMode="decimal"
        step="0.01"
        min="0"
        placeholder="No goal set"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        className="font-mono"
      />
      {error && <p className="text-sm text-error">{error}</p>}
      <Button type="submit" disabled={submitting} className="self-start">
        {submitting ? "Saving…" : "Save goal"}
      </Button>
    </form>
  );
}
