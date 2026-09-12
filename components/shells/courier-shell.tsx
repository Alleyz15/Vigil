import type { RoleIdentity } from "@/lib/workbench/service";
import { IdentityBar } from "./identity-bar";
import { RoleSwitcher } from "./role-switcher";

/**
 * The courier surface. HANDHELD-SHAPED, and deliberately not an application.
 *
 * NO NAVIGATION, and that absence is the point. A sidebar is the single
 * strongest signal that a viewer is looking at the console; removing it says
 * "this is a different person on a different device" faster than any label
 * could, and it is legible in one frame with the sound off. A courier scanning
 * a parcel has one thing to do, and a surface offering them a work queue would
 * be describing a product nobody is building — see anti-reference 3.
 *
 * The narrow column is doing the same work. Next to the operator's 1680px
 * workspace it reads as a phone held in one hand, which is what it is.
 */
export function CourierShell({
  identity,
  children,
}: {
  identity: RoleIdentity;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-muted/40">
      {/* The demo control sits OUTSIDE the device frame, so nothing inside the
          frame is anything but the courier's own surface. */}
      <div className="flex justify-end px-4 py-3">
        <RoleSwitcher />
      </div>

      <div className="mx-auto max-w-md px-4 pb-16">
        <div className="overflow-hidden rounded-2xl bg-background shadow-sm">
          <IdentityBar identity={identity} />
          <div className="p-4">{children}</div>
        </div>
      </div>
    </div>
  );
}
