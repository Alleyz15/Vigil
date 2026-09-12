import type { RoleIdentity } from "@/lib/workbench/service";
import { IdentityBar } from "./identity-bar";
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
  children,
}: {
  identity: RoleIdentity;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-muted/40">
      {/* Outside the working surface, like the courier's. */}
      <div className="flex justify-end px-4 py-3">
        <RoleSwitcher />
      </div>

      <div className="mx-auto max-w-3xl px-4 pb-16">
        <div className="overflow-hidden rounded-2xl bg-background shadow-sm">
          <IdentityBar identity={identity} />
          <div className="p-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
