"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api-client";

export function ResetConfirmForm({ token }: { token: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const { ok, data } = await apiFetch<{ message?: string }>(
      "/api/auth/reset-password/confirm",
      { body: { token, password } }
    );

    setSubmitting(false);

    if (!ok) {
      setError(data.message ?? "Something went wrong. Try again.");
      return;
    }

    setDone(true);
  }

  if (done) {
    return (
      <div className="flex flex-col gap-4 text-center">
        <p className="text-on-background">Password updated. You can now log in.</p>
        <Link href="/login">
          <Button className="w-full">Go to login</Button>
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <TextField
          id="password"
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-xs text-on-surface-variant">
          At least 12 characters, mixing 3 of: lowercase, uppercase, numbers, symbols.
        </p>
      </div>

      {error && <p className="text-sm text-error">{error}</p>}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? "Updating…" : "Update password"}
      </Button>
    </form>
  );
}
