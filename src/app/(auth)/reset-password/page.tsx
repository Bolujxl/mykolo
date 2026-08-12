import type { Metadata } from "next";
import { requireGuest } from "@/lib/auth/guards";
import { AuthSplitLayout } from "@/components/AuthSplitLayout";
import { ResetRequestForm } from "@/components/auth/ResetRequestForm";

export const metadata: Metadata = { title: "Reset password — KoloVault" };

export default async function ResetPasswordPage() {
  await requireGuest();

  return (
    <AuthSplitLayout
      title="Forgot your password?"
      subtitle="No worries. Tell us your email and we'll send a link if we find an account."
    >
      <ResetRequestForm />
    </AuthSplitLayout>
  );
}
