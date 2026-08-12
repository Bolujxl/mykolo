import type { Metadata } from "next";
import { requireGuest } from "@/lib/auth/guards";
import { AuthSplitLayout } from "@/components/AuthSplitLayout";
import { ResetConfirmForm } from "@/components/auth/ResetConfirmForm";

export const metadata: Metadata = { title: "Set a new password — KoloVault" };

export default async function ResetPasswordConfirmPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  await requireGuest();
  const { token } = await params;

  return (
    <AuthSplitLayout title="Choose a new password" subtitle="Make it one you'll remember — you won't need the old one again.">
      <ResetConfirmForm token={token} />
    </AuthSplitLayout>
  );
}
