import type { Metadata } from "next";
import { requireGuest } from "@/lib/auth/guards";
import { AuthCard } from "@/components/AuthCard";
import { ResetConfirmForm } from "@/components/auth/ResetConfirmForm";

export const metadata: Metadata = { title: "Set a new password — Koloclay" };

export default async function ResetPasswordConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await requireGuest();
  const { token } = await params;

  return (
    <AuthCard title="Set a new password" subtitle="Choose something you haven't used before.">
      <ResetConfirmForm token={token} />
    </AuthCard>
  );
}
