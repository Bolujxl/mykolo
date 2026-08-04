import type { Metadata } from "next";
import { requireGuest } from "@/lib/auth/guards";
import { AuthCard } from "@/components/AuthCard";
import { ResetRequestForm } from "@/components/auth/ResetRequestForm";

export const metadata: Metadata = { title: "Reset password — Koloclay" };

export default async function ResetPasswordPage() {
  await requireGuest();

  return (
    <AuthCard
      title="Reset your password"
      subtitle="We'll email you a link if that address has an account."
    >
      <ResetRequestForm />
    </AuthCard>
  );
}
