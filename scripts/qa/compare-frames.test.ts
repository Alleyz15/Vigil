import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";

it("strict comparison accepts identical frames and rejects a single changed pixel or missing frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "vigil-pixel-test-"));
  const before = join(root, "before"), after = join(root, "after");
  mkdirSync(before); mkdirSync(after);
  const image = (dir: string, name: string, red = 0) => sharp({
    create: { width: 1, height: 1, channels: 4, background: { r: red, g: 0, b: 0, alpha: 1 } },
  }).png().toFile(join(dir, name));
  const compare = () => spawnSync(process.execPath, [resolve("scripts/qa/compare-frames.mjs"), before, after], {
    encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" },
  });
  try {
    await image(before, "frame.png"); await image(after, "frame.png");
    expect(compare().status).toBe(0);
    await image(after, "frame.png", 1);
    const changed = compare();
    expect(changed.status).toBe(1);
    expect(changed.stdout).toContain("1 changed pixels");
    await image(before, "missing.png");
    expect(compare().status).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
