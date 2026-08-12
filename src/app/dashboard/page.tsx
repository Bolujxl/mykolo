import type { Metadata } from "next";
import Link from "next/link";
import { requireAuth } from "@/lib/auth/guards";
import { prisma } from "@/lib/db";
import { formatCurrency } from "@/lib/api-client";
import { AppHeader } from "@/components/AppHeader";
import { AddEntryForm } from "@/components/dashboard/AddEntryForm";
import { EntryList } from "@/components/dashboard/EntryList";
import { GoalProgress } from "@/components/dashboard/GoalProgress";

export const metadata: Metadata = { title: "Dashboard — KoloVault" };

export default async function DashboardPage() {
  const { userId } = await requireAuth();

  const [user, entries] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.entry.findMany({ where: { userId }, orderBy: { date: "desc" } }),
  ]);

  const totalCents = entries.reduce((sum, entry) => sum + entry.amountCents, 0);

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader />
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-4 py-8">
        <section className="rounded-2xl border border-outline bg-surface p-6">
          <p className="text-sm text-on-surface-variant">Total saved</p>
          <p className="mt-1 font-mono text-4xl font-semibold text-secondary">
            {formatCurrency(totalCents)}
          </p>

          <div className="mt-4">
            <GoalProgress totalCents={totalCents} goalCents={user.goalAmountCents} />
          </div>

          {!user.goalAmountCents && (
            <p className="mt-4 text-sm text-on-surface-variant">
              <Link href="/settings" className="font-medium text-primary">
                Set a goal
              </Link>{" "}
              to track your progress.
            </p>
          )}
        </section>

        <AddEntryForm />

        <section className="rounded-2xl border border-outline bg-surface p-5">
          <h2 className="mb-2 font-medium text-on-background">Entries</h2>
          <EntryList entries={entries} />
        </section>
      </main>
    </div>
  );
}
