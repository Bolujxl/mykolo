import type { Metadata } from "next";
import { requireGuest } from "@/lib/auth/guards";
import { AuthSplitLayout } from "@/components/AuthSplitLayout";
import { SignupForm } from "@/components/auth/SignupForm";

export const metadata: Metadata = { title: "Create account — KoloVault" };

export default async function SignupPage() {
  await requireGuest();

  return (
    <AuthSplitLayout title="Open your own kolo" subtitle="Takes a minute to set up. No spare change required.">
      <SignupForm />
    </AuthSplitLayout>
  );
}
