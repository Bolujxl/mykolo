"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api-client";

export function ResetRequestForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    const { ok, data } = await apiFetch<{ message?: string }>(
      "/api/auth/reset-password/request",
      { body: { email } }
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
        <p className="text-on-background">
          If that email has an account, a reset link has been sent.
        </p>
        <Link href="/login" className="text-sm font-medium text-primary">
          Back to login
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <TextField
        id="email"
        label="Email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      {error && <p className="text-sm text-error">{error}</p>}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? "Sending…" : "Send reset link"}
      </Button>

      <Link href="/login" className="text-center text-sm font-medium text-primary">
        Back to login
      </Link>
    </form>
  );
}
