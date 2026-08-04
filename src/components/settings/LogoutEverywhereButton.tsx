"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { apiFetch } from "@/lib/api-client";

export function LogoutEverywhereButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    await apiFetch("/api/auth/logout-everywhere", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <Button variant="danger" onClick={handleClick} disabled={loading}>
      {loading ? "Logging out everywhere…" : "Log out everywhere"}
    </Button>
  );
}
