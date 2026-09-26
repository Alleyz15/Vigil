import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("console light-theme contrast", () => {
  it("does not use dark-surface-only foreground tokens without a light-theme counterpart", () => {
    for (const path of [
      "components/console/stream-view.tsx",
      "components/console/timeline-view.tsx",
      "components/console/verdict-badge.tsx",
    ]) {
      expect(source(path), `${path} contains an unpaired low-contrast foreground`).not.toMatch(
        /(?<!dark:)text-(?:sky|amber|rose|violet|emerald)-(?:200|300)\b/,
      );
    }
  });
});
