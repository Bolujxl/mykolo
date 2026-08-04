import type { Metadata } from "next";
import { requireGuest } from "@/lib/auth/guards";
import { AuthCard } from "@/components/AuthCard";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata: Metadata = { title: "Log in — Koloclay" };

export default async function LoginPage() {
  await requireGuest();

  return (
    <AuthCard title="Welcome back" subtitle="Log in to keep watching your kolo grow.">
      <LoginForm />
    </AuthCard>
  );
}
