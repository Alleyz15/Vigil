"use client";

import { useRouter, useSearchParams } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type ScenarioOption = {
  id: string;
  title: string;
  expectedDecision: string;
};

/**
 * The scenario picker.
 *
 * Writes to the query string rather than component state, so every view is
 * deep-linkable: /timeline?scenario=S2 goes straight to the argument.
 */
export function ScenarioPicker({
  scenarios,
  value,
  basePath,
}: {
  scenarios: ScenarioOption[];
  value: string;
  basePath: string;
}) {
  const router = useRouter();
  const params = useSearchParams();

  return (
    <Select
      value={value}
      onValueChange={(next) => {
        // Radix types this as nullable; a cleared selection is not a scenario.
        if (!next) return;
        const search = new URLSearchParams(params?.toString() ?? "");
        search.set("scenario", next);
        search.delete("leg");
        search.delete("frame");
        router.push(`${basePath}?${search.toString()}`);
      }}
    >
      <SelectTrigger className="w-[26rem]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {scenarios.map((scenario) => (
          <SelectItem key={scenario.id} value={scenario.id}>
            <span className="font-mono text-xs">{scenario.id}</span>
            <span className="ml-2">{scenario.title}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
