"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api-client";

export function DeleteEntryButton({ id }: { id: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleDelete() {
    setLoading(true);
    await apiFetch(`/api/entries/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <button
      onClick={handleDelete}
      disabled={loading}
      aria-label="Remove entry"
      className="text-sm text-error hover:underline disabled:opacity-60"
    >
      {loading ? "…" : "Remove"}
    </button>
  );
}
