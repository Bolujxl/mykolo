"use client";

import dynamic from "next/dynamic";
import { Logo } from "./Logo";

// WebGL needs a real DOM/canvas — dynamic-imported client-only so it never
// touches the server render, and code-split so only auth pages load it.
const SilkBackground = dynamic(() => import("./auth/SilkBackground"), {
  ssr: false,
});

export function AuthSplitLayout({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen w-full bg-background p-2 md:p-3">
      <div className="flex min-h-[calc(100vh-1rem)] w-full overflow-hidden rounded-2xl md:min-h-[calc(100vh-1.5rem)] md:rounded-[28px]">
        {/* Left: visual panel — Silk lives only here, never behind the form. */}
        <div className="relative hidden w-[40%] flex-col justify-between overflow-hidden p-10 md:flex lg:p-12">
          <div className="absolute inset-0">
            <SilkBackground className="h-full w-full" />
          </div>
          {/* Legibility scrim so the copy reads regardless of what the
              animation is doing underneath at any given moment. */}
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/20" />

          <div className="relative z-10">
            <Logo size={32} color="#ffffff" notchColor="rgba(0,0,0,0.35)" />
          </div>

          <div className="relative z-10 flex flex-col gap-3 text-white">
            <h2 className="text-2xl font-semibold leading-snug lg:text-[1.75rem]">
              Drop a coin. Watch it grow.
            </h2>
            <p className="max-w-xs text-sm text-white/75">
              KoloVault is the everyday savings pot, digitized — log what you
              set aside, watch the total climb, and always know how close you
              are to what you&apos;re saving for.
            </p>
          </div>
        </div>

        {/* Right: form panel — normal page background, no Silk underneath. */}
        <div className="flex w-full flex-col items-center justify-center bg-background px-6 py-12 sm:px-10 md:w-[60%] md:px-12 lg:px-20">
          <div className="mb-8 md:hidden">
            <Logo size={32} />
          </div>

          <div className="w-full max-w-sm">
            <div className="mb-8">
              <h1 className="text-2xl font-semibold text-on-background">{title}</h1>
              {subtitle && (
                <p className="mt-1 text-sm text-on-surface-variant">{subtitle}</p>
              )}
            </div>
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
