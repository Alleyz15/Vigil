// Explicit QA preload only. Never imported by application code.
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";

if (process.env.VIGIL_QA !== "1" || !process.env.VIGIL_QA_KEY_SEED || process.env.NODE_ENV === "production") {
  throw new Error("Fixed keys require an explicit non-production VIGIL_QA=1 process and VIGIL_QA_KEY_SEED.");
}

const original = crypto.generateKeyPairSync;
let index = 0;
crypto.generateKeyPairSync = (type, options) => {
  if (type !== "ed25519") return original(type, options);
  if (options !== undefined) throw new Error("QA Ed25519 fixture expects KeyObject output without encoding options.");
  const seed = crypto.createHash("sha256")
    .update(JSON.stringify(["vigil-qa-only", process.env.VIGIL_QA_KEY_SEED, index++])).digest();
  const privateKey = crypto.createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der", type: "pkcs8",
  });
  return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
};
syncBuiltinESMExports();
