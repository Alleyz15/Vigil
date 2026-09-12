import { KeyRound, Smartphone, Monitor, Clock } from "lucide-react";
import type { RoleIdentity } from "@/lib/workbench/service";
import { cn } from "@/lib/utils";

/**
 * Who is acting, always visible.
 *
 * THE TEST THIS IS BUILT AGAINST: a single frame of video, no audio, no
 * captions. A viewer who pauses on a screenshot must be able to say which of
 * three people they are looking at. The co-sign demo only means anything if the
 * audience understands that the courier and the operator are TWO DIFFERENT
 * PEOPLE — one person clicking twice proves nothing about a co-signature.
 *
 * THE KEY IS SHOWN BECAUSE THE KEY IS THE IDENTITY. In this system a name is a
 * label and a signature is the fact: `vigil:courierId` is an unverified claim
 * by construction, while the Ed25519 key is what a credential is actually
 * checked against. Putting the fingerprint in the furniture states the argument
 * while it identifies the user. Every fingerprint here is a truncation of a
 * REAL key — see `identities()`.
 */

const ROLE_STYLE = {
  courier: {
    Icon: Smartphone,
    band: "bg-sky-950 text-sky-50",
    accent: "text-sky-200",
  },
  operator: {
    Icon: Monitor,
    band: "bg-slate-900 text-slate-50",
    accent: "text-slate-300",
  },
  recipient: {
    Icon: KeyRound,
    band: "bg-violet-950 text-violet-50",
    accent: "text-violet-200",
  },
} as const;

export function IdentityBar({
  identity,
  expiresIn,
}: {
  identity: RoleIdentity;
  /** Recipient only: how long the one-time link remains usable. */
  expiresIn?: string | null;
}) {
  const style = ROLE_STYLE[identity.role];
  const Icon = style.Icon;

  return (
    <div className={cn("flex flex-wrap items-center gap-3 px-4 py-2", style.band)}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />

      <span className="text-xs font-semibold uppercase tracking-widest">{identity.role}</span>

      <span className={cn("text-sm font-medium", style.accent)}>{identity.label}</span>

      {identity.keyFingerprint ? (
        <span className={cn("ml-auto font-mono text-xs", style.accent)}>
          {identity.keyFingerprint}
        </span>
      ) : (
        <span className={cn("ml-auto inline-flex items-center gap-2 font-mono text-xs", style.accent)}>
          <Clock aria-hidden="true" className="size-3" />
          {expiresIn ? `expires in ${expiresIn}` : "one-time link"}
        </span>
      )}
    </div>
  );
}
