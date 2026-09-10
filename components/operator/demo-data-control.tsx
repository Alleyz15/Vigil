"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { FlaskConical } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const SCENARIOS = [
  ["all", "All seeded shipments"],
  ["S0", "S0 · Normal delivery"],
  ["S1", "S1 · GPS spoofing"],
  ["S2", "S2 · Condo batch scanning"],
  ["S3", "S3 · Event ID reuse"],
  ["S4", "S4 · Out-of-scope scan"],
  ["S5", "S5 · Clock tampering"],
  ["S6", "S6 · Degraded basement GPS"],
] as const;

export function DemoDataControl() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const current = searchParams.get("scenario") ?? "all";

  return (
    <div className="flex items-center gap-2">
      <FlaskConical aria-hidden="true" className="size-4 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">Loads seeded synthetic shipment</span>
      <Select
        value={current}
        onValueChange={(next) => {
          if (!next) return;
          const params = new URLSearchParams(searchParams.toString());
          if (next === "all") params.delete("scenario");
          else params.set("scenario", next);
          const query = params.toString();
          router.push(query ? `${pathname}?${query}` : pathname);
        }}
      >
        <SelectTrigger size="sm" className="w-64 bg-card">
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            <SelectLabel>Seeded synthetic shipments</SelectLabel>
            {SCENARIOS.map(([id, label]) => (
              <SelectItem key={id} value={id}>{label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}
