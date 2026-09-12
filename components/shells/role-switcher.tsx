"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Move between the three roles. A DEMO AFFORDANCE, labelled as one.
 *
 * In production nobody changes identity: a courier is a courier because they
 * hold a courier key, and no control anywhere hands them the operator's. This
 * exists so one person can walk an audience through a flow that in reality
 * involves three people and two devices.
 *
 * Same discipline as the scenario picker (anti-reference 2): a demo control
 * belongs in a quiet corner and must say honestly what it is, rather than
 * looking like a product feature that lets staff impersonate each other.
 */

const ROLES = [
  { href: "/operator/inbox", label: "Operator", match: "/operator" },
  { href: "/courier", label: "Courier", match: "/courier" },
  { href: "/demo/cosign", label: "Both", match: "/demo/cosign" },
] as const;

export function RoleSwitcher({ className }: { className?: string }) {
  const pathname = usePathname();

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <FlaskConical aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">Acting as</span>

      <div className="flex items-center rounded-md bg-muted p-1" role="group" aria-label="Demo role">
        {ROLES.map((role) => {
          const active = pathname.startsWith(role.match);
          return (
            <Link
              key={role.href}
              href={role.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "rounded px-3 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {role.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
