import type { RoleIdentity } from "@/lib/workbench/service";
import Link from "next/link";
import { MapPin, PackagePlus, Shield, Truck, Waypoints } from "lucide-react";
import { RoleSwitcher } from "./role-switcher";

/**
 * The sender surface. A MERCHANT AT A DESK, and the fourth distinct shape.
 *
 * With four surfaces the single-frame test gets harder rather than easier —
 * colour stops carrying it on its own, so each one is a different structure:
 *
 *   courier    narrow device column, no navigation
 *   operator   sidebar workspace, dense tables
 *   recipient  centred card, no chrome at all
 *   sender     a wide form on a working surface, no sidebar
 *
 * A form is the giveaway. None of the other three ask the viewer to fill
 * anything in, and a page of labelled inputs reads as data entry before a
 * single word is read.
 *
 * WHY THE SENDER IS A PARTY AND NOT A DEMO CONTROL: their declarations are
 * already inputs the engine cross-checks — the address I10/I11 measure against,
 * the value that decides whether a co-signature is required, the channel I15
 * verifies. Those values used to appear from nowhere.
 */
export function SenderShell({
  identity,
  addressCount,
  children,
}: {
  identity: RoleIdentity;
  addressCount: number;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background">
      <aside className="sender-sidebar border-r bg-sidebar px-3.5 py-5">
        <Link href="/sender" className="flex items-center gap-2 px-2 py-2"><span className="relative flex size-11 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground"><Shield aria-hidden="true" className="absolute size-7" /><Waypoints aria-hidden="true" className="relative size-3.5" /></span><span><span className="block text-base font-semibold">Vigil</span><span className="block text-xs text-muted-foreground">sender dispatch</span></span></Link>
        <nav aria-label="Sender navigation" className="mt-8 flex flex-col gap-2 text-sm">
          <a href="#create-shipment" className="flex h-9 items-center gap-2 rounded-md bg-amber-100 px-3 font-medium text-amber-900"><PackagePlus aria-hidden="true" className="size-4" />Create shipment</a>
          <a href="#pending-deliveries" className="flex h-9 items-center gap-2 rounded-md px-3 text-muted-foreground hover:bg-muted"><Truck aria-hidden="true" className="size-4" />Pending deliveries</a>
        </nav>
        <p className="mt-auto border-t pt-4 text-xs leading-5 text-muted-foreground">Simulated identity · real Ed25519 signatures</p>
      </aside>
      <div className="sender-main min-w-0">
        <header className="flex flex-wrap items-center justify-end gap-4 border-b-4 border-amber-500 bg-sidebar px-5 py-4"><RoleSwitcher className="flex-wrap" /><span className="flex items-center gap-2 text-xs text-muted-foreground"><MapPin aria-hidden="true" className="size-4" />{addressCount} registered points</span></header>
        <main className="mx-auto max-w-[1440px] px-5 py-8 md:px-9"><span className="sr-only">Acting sender: {identity.subject}</span>{children}</main>
      </div>
    </div>
  );
}
