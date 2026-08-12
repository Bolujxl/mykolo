import type { Metadata } from "next";
import { requireAuth } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { AppHeader } from "@/components/AppHeader";
import { GoalForm } from "@/components/settings/GoalForm";
import { LogoutEverywhereButton } from "@/components/settings/LogoutEverywhereButton";

export const metadata: Metadata = { title: "Settings — KoloVault" };

export default async function SettingsPage() {
  const { userId } = await requireAuth();
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
        <section className="rounded-2xl border border-outline bg-surface p-6">
          <p className="text-sm text-on-surface-variant">Signed in as {user.email}</p>
        </section>

        <section className="rounded-2xl border border-outline bg-surface p-6">
          <h2 className="mb-1 font-medium text-on-background">Savings goal</h2>
          <p className="mb-4 text-sm text-on-surface-variant">
            Shown as a progress bar on your dashboard. Leave blank to remove it.
          </p>
          <GoalForm initialGoalCents={user.goalAmountCents} />
        </section>

        <section className="rounded-2xl border border-outline bg-surface p-6">
          <h2 className="mb-1 font-medium text-on-background">Sessions</h2>
          <p className="mb-4 text-sm text-on-surface-variant">
            Sign out of KoloVault everywhere you&apos;re logged in, including this device.
          </p>
          <LogoutEverywhereButton />
        </section>
      </main>
    </div>
  );
}
