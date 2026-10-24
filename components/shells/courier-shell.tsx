import type { RoleIdentity } from "@/lib/workbench/service";
import Link from "next/link";
import { ClipboardList, FileQuestion, FlaskConical, Shield, Waypoints } from "lucide-react";
import { RoleSwitcher } from "./role-switcher";
import { IdentityBar } from "./identity-bar";
import { cn } from "@/lib/utils";

export type CourierMode = "handoffs" | "evidence";

export function CourierShell({
  identity,
  children,
  identityControls,
  mode = "handoffs",
  onModeChange,
  evidenceCount = 0,
  busy = false,
}: {
  identity: RoleIdentity;
  children: React.ReactNode;
  identityControls?: React.ReactNode;
  mode?: CourierMode;
  onModeChange?: (mode: CourierMode) => void;
  evidenceCount?: number;
  busy?: boolean;
}) {
  return (
    <div className="min-h-screen bg-background">
      <aside className="courier-sidebar border-r bg-sidebar px-3.5 py-5">
        <Link href="/courier" className="flex items-center gap-2 px-2 py-2">
          <span className="relative flex size-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Shield aria-hidden="true" className="absolute size-7" />
            <Waypoints aria-hidden="true" className="relative size-3.5" />
          </span>
          <span><span className="block text-base font-semibold">Vigil</span><span className="block text-xs text-muted-foreground">courier workspace</span></span>
        </Link>
        <nav aria-label="Courier navigation" className="mt-8 space-y-1">
          <button type="button" disabled={busy} aria-current={mode === "handoffs" ? "page" : undefined} onClick={() => onModeChange?.("handoffs")} className={cn("flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium hover:bg-sidebar-accent disabled:opacity-60", mode === "handoffs" && "bg-sidebar-accent text-sidebar-accent-foreground")}>
            <ClipboardList aria-hidden="true" className="size-4 shrink-0" />Your handoffs
          </button>
          <button type="button" disabled={busy} aria-current={mode === "evidence" ? "page" : undefined} onClick={() => onModeChange?.("evidence")} className={cn("flex min-h-9 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium hover:bg-sidebar-accent disabled:opacity-60", mode === "evidence" && "bg-sidebar-accent text-sidebar-accent-foreground")}>
            <FileQuestion aria-hidden="true" className="size-4 shrink-0" /><span>Evidence requests</span><span className="ml-auto text-xs tabular-nums">{evidenceCount}</span>
          </button>
        </nav>
        <p className="mt-auto border-t pt-4 text-xs leading-5 text-muted-foreground">Simulated identity · real Ed25519 signatures</p>
      </aside>
      <div className="courier-main min-w-0">
        <header className="flex flex-wrap items-center gap-4 border-b bg-sidebar px-5 py-4">
          <div className="mr-auto min-w-0 max-w-full space-y-3">
            <IdentityBar identity={identity} className="break-all" />
            {identityControls}
          </div>
          <RoleSwitcher className="flex-wrap" />
          <span className="flex items-center gap-2 text-xs text-muted-foreground"><FlaskConical aria-hidden="true" className="size-4" />Synthetic demo handoffs</span>
        </header>
        <main className="mx-auto max-w-[1440px] px-5 py-8 md:px-9">
          <span className="sr-only">Acting courier: {identity.subject}</span>
          {children}
        </main>
      </div>
    </div>
  );
}
