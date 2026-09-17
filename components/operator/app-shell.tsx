"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ClipboardList, Database, Link2, Route, Scale, Shield, Syringe, Waypoints } from "lucide-react";
import { cn } from "@/lib/utils";
import { DemoDataControl } from "./demo-data-control";
import { getOperatorShellCopy, isFixedInjectionEvidence } from "./app-shell-model";
import { RoleSwitcher } from "@/components/shells/role-switcher";

const PRIMARY = [
  { href: "/operator/inbox", label: "Handoffs", icon: ClipboardList },
];

const EVIDENCE = [
  { href: "/demo/gate", label: "Gate evidence", icon: Route },
  { href: "/verify", label: "Verify the ledger", icon: Link2 },
  { href: "/demo/models", label: "Model divergence", icon: Scale },
  { href: "/demo/injection", label: "Injection", icon: Syringe },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isHandoffRoute = pathname.startsWith("/operator/inbox") || pathname.startsWith("/operator/handoffs");
  const shellCopy = getOperatorShellCopy(pathname);


  return (
    <div className="flex min-h-screen bg-background">
      <aside className="fixed inset-y-0 left-0 z-40 flex w-[252px] flex-col border-r bg-sidebar px-3.5 py-5">
        <Link href="/operator/inbox" className="flex items-center gap-2 px-2 py-2">
          <span className="relative flex size-11 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Shield aria-hidden="true" className="absolute size-7" />
            <Waypoints aria-hidden="true" className="relative size-3.5" />
          </span>
          <span>
            <span className="block text-base font-semibold leading-tight">Vigil</span>
            <span className="block text-xs text-muted-foreground">operator workbench</span>
          </span>
        </Link>

        <nav className="mt-8 flex flex-col gap-1" aria-label="Operator navigation">
          {PRIMARY.map((item) => {
            const active = isHandoffRoute;
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors",
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

        <div className="mt-8 px-2 text-xs font-semibold uppercase text-muted-foreground">
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
                  "flex h-9 items-center gap-2 rounded-md px-3 text-sm transition-colors",
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

        {/* The identity strip carries who this is; repeating it here would be
            two sources for one fact. What stays is the provenance claim, which
            the strip does NOT make: the identity is simulated and the
            signatures are real. */}
        <div className="mt-auto border-t pt-4">
          <div className="px-2 text-xs leading-4 text-muted-foreground">
            Simulated identity · real Ed25519 signatures
          </div>
        </div>
      </aside>

      <div className="ml-[252px] min-w-0 flex-1">
        <div className="sticky top-0 z-30">
          <header className="flex min-h-24 flex-wrap items-center justify-between gap-x-8 gap-y-3 border-b bg-background/95 px-9 py-4 backdrop-blur-sm">
            <div className="min-w-80 flex-1">
              <div className="text-xl font-semibold">{shellCopy.title}</div>
              <div className="mt-1 max-w-xl text-xs text-muted-foreground">{shellCopy.description}</div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-4">
              <RoleSwitcher />
              {isFixedInjectionEvidence(pathname) ? (
                <div className="flex items-start gap-2">
                  <Database aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <div className="text-xs text-muted-foreground">Evidence source</div>
                    <div className="mt-1 text-sm font-medium">E4c CSV</div>
                  </div>
                </div>
              ) : (
                <Suspense fallback={<div className="h-12 w-52" aria-hidden="true" />}>
                  <DemoDataControl />
                </Suspense>
              )}
            </div>
          </header>
        </div>
        <main className="mx-auto max-w-[1680px] px-9 py-6">{children}</main>
      </div>
    </div>
  );
}
