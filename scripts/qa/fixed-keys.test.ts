import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const preload = pathToFileURL(resolve("scripts/qa/fixed-keys.mjs")).href;
const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "", NODE_ENV: "test", VIGIL_QA: "1", VIGIL_QA_KEY_SEED: "route-baseline" };
const expression = `const c=await import('node:crypto');const keys=[c.generateKeyPairSync('ed25519'),c.generateKeyPairSync('ed25519')];console.log(JSON.stringify(keys.map(k=>({publicKey:k.publicKey.export({format:'der',type:'spki'}).toString('hex'),valid:c.verify(null,Buffer.from('qa'),k.publicKey,c.sign(null,Buffer.from('qa'),k.privateKey))}))))`;

describe("QA-only fixed key preload", () => {
  it("repeats across processes while keeping distinct valid keypairs", () => {
    const run = () => JSON.parse(execFileSync(process.execPath, ["--import", preload, "--input-type=module", "-e", expression], { env, encoding: "utf8" }));
    const first = run();
    expect(run()).toEqual(first);
    expect(first[0].publicKey).not.toBe(first[1].publicKey);
    expect(first.every((key: { valid: boolean }) => key.valid)).toBe(true);
  });
  it("rejects accidental activation and production use", () => {
    const overrides: Partial<NodeJS.ProcessEnv>[] = [{ VIGIL_QA: "" }, { NODE_ENV: "production" }];
    for (const override of overrides) {
      const refused = spawnSync(process.execPath, ["--import", preload, "-e", ""], { env: { ...env, ...override }, encoding: "utf8" });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain("Fixed keys require an explicit non-production");
    }
  });
});
