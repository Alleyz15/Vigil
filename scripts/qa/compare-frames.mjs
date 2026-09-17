import { readdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const [before, after] = process.argv.slice(2);
if (!before || !after) throw new Error("Usage: node scripts/qa/compare-frames.mjs BEFORE AFTER");
const files = (dir) => readdirSync(dir).filter((name) => name.endsWith(".png")).sort();
const names = files(before);
if (!names.length || JSON.stringify(names) !== JSON.stringify(files(after))) throw new Error("Frame sets differ or are empty.");
for (const name of names) {
  const a = await sharp(join(before, name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(join(after, name)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    console.error(`${name}: dimensions differ`); process.exitCode = 1; continue;
  }
  let changed = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    if (!a.data.subarray(i, i + 4).equals(b.data.subarray(i, i + 4))) changed++;
  }
  console.log(`${name}: ${changed} changed pixels`);
  if (changed) process.exitCode = 1;
}
