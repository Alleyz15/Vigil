import type { RoleIdentity } from "@/lib/workbench/service";
import Link from "next/link";
import { ClipboardList, FlaskConical, Shield, Waypoints } from "lucide-react";
import { RoleSwitcher } from "./role-switcher";

// Shared visual language, but no operator queue or evidence navigation.
export function CourierShell({
  identity,
  children,
}: {
  identity: RoleIdentity;
  children: React.ReactNode;
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
        <nav aria-label="Courier navigation" className="mt-8">
          <Link href="/courier" aria-current="page" className="flex h-9 items-center gap-2 rounded-md bg-sidebar-accent px-3 text-sm font-medium text-sidebar-accent-foreground">
            <ClipboardList aria-hidden="true" className="size-4" />Your handoffs
          </Link>
        </nav>
        <p className="mt-auto border-t pt-4 text-xs leading-5 text-muted-foreground">Simulated identity · real Ed25519 signatures</p>
      </aside>
      <div className="courier-main min-w-0">
        <header className="flex flex-wrap items-center justify-end gap-4 border-b bg-sidebar px-5 py-4">
          <RoleSwitcher className="flex-wrap" />
          <span className="flex items-center gap-2 text-xs text-muted-foreground"><FlaskConical aria-hidden="true" className="size-4" />Seeded synthetic shipments</span>
        </header>
        <main className="mx-auto max-w-[1440px] px-5 py-8 md:px-9">
          <span className="sr-only">Acting courier: {identity.subject}</span>
          {children}
        </main>
      </div>
    </div>
  );
}
