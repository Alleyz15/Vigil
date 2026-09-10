"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardList, Inbox, Route, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { DemoDataControl } from "./demo-data-control";

const PRIMARY = [
  { href: "/operator/inbox", label: "Inbox", icon: Inbox },
  { href: "/operator/handoffs", label: "All handoffs", icon: ClipboardList },
];

const EVIDENCE = [
  { href: "/demo/gate", label: "Gate evidence", icon: Route },
];

/**
 * Surfaces that are NOT the operator workbench.
 *
 * A courier must not see the operator's queue and a recipient must not see
 * either — they are different people with different authority, and putting the
 * work queue behind every route would be the surveillance framing anti-
 * reference 3 rules out. These render bare.
 */
const STANDALONE = ["/courier", "/confirm"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  if (STANDALONE.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return <div className="min-h-screen bg-background">{children}</div>;
  }

  return (
    <div className="flex min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 flex w-56 flex-col border-r bg-sidebar px-3 py-4">
        <Link href="/operator/inbox" className="flex items-center gap-2 px-2 py-1.5">
          <span className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck aria-hidden="true" />
          </span>
          <span>
            <span className="block text-sm font-semibold leading-tight">Vigil</span>
            <span className="block text-xs text-muted-foreground">operator workbench</span>
          </span>
        </Link>

        <nav className="mt-7 flex flex-col gap-1" aria-label="Operator navigation">
          {PRIMARY.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-2.5 text-sm font-medium transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-7 px-2 text-[11px] font-semibold uppercase text-muted-foreground">
          Demo evidence
        </div>
        <nav className="mt-2 flex flex-col gap-1" aria-label="Demo evidence">
          {EVIDENCE.map((item) => {
            const active = pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-2.5 text-sm transition-colors",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon aria-hidden="true" className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto border-t pt-4">
          <div className="px-2 text-xs font-medium">Operator · OP-01</div>
          <div className="mt-1 px-2 text-[11px] leading-4 text-muted-foreground">
            Simulated identity · real Ed25519 signatures
          </div>
        </div>
      </aside>

      <div className="ml-56 min-w-0 flex-1">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-background/95 px-7 backdrop-blur-sm">
          <div className="text-sm text-muted-foreground">Process handoffs that need a decision</div>
          <Suspense fallback={<div className="h-8 w-[26rem]" aria-hidden="true" />}>
            <DemoDataControl />
          </Suspense>
        </header>
        <main className="mx-auto max-w-[1680px] px-7 py-6">{children}</main>
      </div>
    </div>
  );
}
