import type { Metadata } from "next";
import { requireGuest } from "@/lib/auth/guards";
import { AuthSplitLayout } from "@/components/AuthSplitLayout";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata: Metadata = { title: "Log in — KoloVault" };

export default async function LoginPage() {
  await requireGuest();

  return (
    <AuthSplitLayout title="Welcome back" subtitle="Your kolo's right where you left it.">
      <LoginForm />
    </AuthSplitLayout>
  );
}
