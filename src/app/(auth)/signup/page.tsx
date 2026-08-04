import type { Metadata } from "next";
import { requireGuest } from "@/lib/auth/guards";
import { AuthCard } from "@/components/AuthCard";
import { SignupForm } from "@/components/auth/SignupForm";

export const metadata: Metadata = { title: "Create account — Koloclay" };

export default async function SignupPage() {
  await requireGuest();

  return (
    <AuthCard title="Start your kolo" subtitle="Drop a coin today, find a sum later.">
      <SignupForm />
    </AuthCard>
  );
}
