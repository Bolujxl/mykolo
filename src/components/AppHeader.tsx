import Link from "next/link";
import { Logo } from "./Logo";
import { LogoutButton } from "./LogoutButton";

export function AppHeader() {
  return (
    <header className="border-b border-outline">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 py-4">
        <Link href="/dashboard" className="flex items-center gap-2">
          <Logo size={26} />
          <span className="text-lg font-semibold text-on-background">KoloVault</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/dashboard" className="text-on-background hover:text-primary">
            Dashboard
          </Link>
          <Link href="/settings" className="text-on-background hover:text-primary">
            Settings
          </Link>
          <LogoutButton />
        </nav>
      </div>
    </header>
  );
}
