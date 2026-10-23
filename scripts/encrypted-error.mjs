/** Encrypt captured Wrangler output for private investigation; no plaintext evidence/logs. @file */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  constants,
  createCipheriv,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

/** Load only a public encryption key before allowing the existing deploy invocation. */
export function errorSealer(
  jwk = JSON.parse(
    readFileSync(
      new URL("./wrangler-evidence-public-key.json", import.meta.url),
      "utf8",
    ),
  ),
) {
  assert.equal(jwk.kty, "RSA");
  assert.match(jwk.kid, /^gateway-wrangler-evidence-[a-f0-9]{32}$/);
  assert.deepEqual(Object.keys(jwk).sort(), ["e", "kid", "kty", "n"]);
  const key = createPublicKey({ key: jwk, format: "jwk" });
  assert.ok(key.asymmetricKeyDetails.modulusLength >= 3072);

  return (error, env = {}) => {
    if (env.CI_ENVIRONMENT !== "dev") return null;
    const context = {
      sourceSha: /^[a-f0-9]{40}$/.test(env.CI_SOURCE_SHA ?? "")
        ? env.CI_SOURCE_SHA
        : null,
      environment: ["dev", "production"].includes(env.CI_ENVIRONMENT)
        ? env.CI_ENVIRONMENT
        : null,
      workflowRunId: /^\d+$/.test(env.GITHUB_RUN_ID ?? "")
        ? env.GITHUB_RUN_ID
        : null,
    };
    const header = {
      schemaVersion: 1,
      algorithm: "RSA-OAEP-256+A256GCM",
      keyId: jwk.kid,
      ...context,
    };
    const contentKey = randomBytes(32);
    const nonce = randomBytes(12);
    let plaintext;
    try {
      // Preserve all captured text, not an error-pattern subset. execFileSync's existing
      // output limit still applies; never serialize its command options/environment.
      const text = (value) =>
        typeof value === "string" || Buffer.isBuffer(value)
          ? value.toString()
          : null;
      plaintext = Buffer.from(
        JSON.stringify({
          message: text(error?.message),
          stdout: text(error?.stdout),
          stderr: text(error?.stderr),
          code: text(error?.code),
          signal: text(error?.signal),
          exitCode: Number.isInteger(error?.status) ? error.status : null,
        }),
      );
      const cipher = createCipheriv("aes-256-gcm", contentKey, nonce);
      cipher.setAAD(Buffer.from(JSON.stringify(header)));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      return {
        ...header,
        wrappedKey: publicEncrypt(
          {
            key,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
          },
          contentKey,
        ).toString("base64"),
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    } finally {
      contentKey.fill(0);
      plaintext?.fill(0);
    }
  };
}
