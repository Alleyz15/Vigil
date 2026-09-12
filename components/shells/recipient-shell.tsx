import { IdentityBar } from "./identity-bar";

/**
 * The recipient surface. PHONE-SHAPED, and the sparsest thing in the project.
 *
 * NO CHROME AT ALL — no navigation, no role switcher, no scenario picker, no
 * way to reach anything else. That is not minimalism for its own sake: the
 * recipient holds a scoped capability for one parcel, and a surface offering
 * them anything beyond that question would be offering what the token does not
 * authorise. The page matches the grant.
 *
 * It is also the single-frame test at its easiest: a centred card on an empty
 * ground, with a violet identity strip and no application furniture, cannot be
 * mistaken for either of the other two roles.
 */
export function RecipientShell({
  expiresIn,
  children,
}: {
  expiresIn?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 px-4 py-8">
      <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-background shadow-sm">
        <IdentityBar
          identity={{
            role: "recipient",
            label: "One-time link",
            subject: "recipient",
            // A recipient holds no key. Showing a fingerprint here would invent
            // an identity the system does not have for them — their capability
            // IS the link, and the strip says so instead.
            keyFingerprint: null,
          }}
          expiresIn={expiresIn}
        />
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
