import { expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from "node:crypto";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorSealer } from "../scripts/encrypted-error.mjs";
import {
  deploymentExecutor,
  retainDeploymentFailure,
} from "../scripts/deployment-error.mjs";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 3072,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: `gateway-wrangler-evidence-${"a".repeat(32)}`,
};
const env = {
  CI_SOURCE_SHA: "a".repeat(40),
  CI_ENVIRONMENT: "dev",
  GITHUB_RUN_ID: "1234",
};

/** Fixture-only decryption: real private keys must never reach CI, Git or logs. */
function decrypt(envelope, recipient = privateKey) {
  const { wrappedKey, nonce, tag, ciphertext, ...header } = envelope;
  const key = privateDecrypt(
    {
      key: recipient,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(wrappedKey, "base64"),
  );
  try {
    const cipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(nonce, "base64"),
    );
    cipher.setAAD(Buffer.from(JSON.stringify(header)));
    cipher.setAuthTag(Buffer.from(tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(ciphertext, "base64")),
        cipher.final(),
      ]).toString(),
    );
  } finally {
    key.fill(0);
  }
}

it("round-trips the complete captured error but never retains plaintext or the environment", () => {
  const raw = {
    message: "secret-message",
    stdout: "unknown-secret stdout\n".repeat(100_000),
    stderr: Buffer.from("previously-unrecognized failure with credential"),
    code: "UNKNOWN",
    status: 1,
    signal: null,
    env: { TOKEN: "do-not-serialize-env" },
  };
  const envelope = errorSealer(jwk)(raw, {
    ...env,
    SECRET: "do-not-serialize-env",
  });
  expect(envelope).toMatchObject({
    ...envToContext(env),
    algorithm: "RSA-OAEP-256+A256GCM",
  });
  expect(JSON.stringify(envelope)).not.toMatch(
    /secret|credential|do-not-serialize-env|UNKNOWN/,
  );
  expect(decrypt(envelope)).toEqual({
    message: raw.message,
    stdout: raw.stdout,
    stderr: raw.stderr.toString(),
    code: "UNKNOWN",
    exitCode: 1,
    signal: null,
  });
});

/** Match the authenticated public source/run context. */
function envToContext(value) {
  return {
    sourceSha: value.CI_SOURCE_SHA,
    environment: value.CI_ENVIRONMENT,
    workflowRunId: value.GITHUB_RUN_ID,
  };
}

it("uses fresh randomness and authenticates ciphertext, recipient and source context", () => {
  const seal = errorSealer(jwk);
  const a = seal({ stderr: "fixture" }, env);
  const b = seal({ stderr: "fixture" }, env);
  expect(a.nonce).not.toBe(b.nonce);
  expect(a.wrappedKey).not.toBe(b.wrappedKey);
  expect(a.ciphertext).not.toBe(b.ciphertext);
  for (const patch of [
    { sourceSha: "b".repeat(40) },
    { environment: "production" },
    { workflowRunId: "9999" },
    { keyId: "other" },
    { ciphertext: Buffer.from("tamper").toString("base64") },
    { tag: Buffer.alloc(16).toString("base64") },
  ])
    expect(() => decrypt({ ...a, ...patch })).toThrow();
  const other = generateKeyPairSync("rsa", { modulusLength: 3072 });
  expect(() => decrypt(a, other.privateKey)).toThrow();
});

it("does not capture production or unselected targets", () => {
  const seal = errorSealer(jwk);
  for (const environment of [undefined, "production", "other"]) {
    expect(
      seal({ stderr: "secret" }, { CI_ENVIRONMENT: environment }),
    ).toBeNull();
  }
});

it("rejects private, weak and malformed recipient keys before any deploy invocation", () => {
  const weak = generateKeyPairSync("rsa", { modulusLength: 2048 });
  for (const value of [
    { ...jwk, d: "private" },
    { ...jwk, kid: "other" },
    { ...jwk, kty: "EC" },
    { ...weak.publicKey.export({ format: "jwk" }), kid: jwk.kid },
  ]) {
    const execute = vi.fn();
    expect(() =>
      deploymentExecutor(execute, vi.fn(), errorSealer(value)),
    ).toThrow();
    expect(execute).not.toHaveBeenCalled();
  }
  expect(() => errorSealer()).not.toThrow();
});

it("retains only ciphertext in the existing atomic checkpoint and suppresses encryption errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-encrypted-test-"));
  try {
    const path = join(directory, "delivery-record.json");
    const original = {
      ...envToContext(env),
      status: "mutation-requested",
      deploymentId: null,
      previousDeploymentId: "prior",
    };
    writeFileSync(path, JSON.stringify(original));
    const retain = (diagnostic, ignored, encrypted) =>
      retainDeploymentFailure(diagnostic, path, encrypted);
    const execute = vi.fn(() => {
      throw Object.assign(Error("secret-message"), {
        stderr: "secret-output",
        status: 1,
      });
    });
    expect(() =>
      deploymentExecutor(execute, retain, errorSealer(jwk))("node", [], {
        env,
      }),
    ).toThrow("WRANGLER_FAILED_INSPECT_RETAINED_CLASSIFICATION");
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record).toMatchObject(original);
    expect(readFileSync(path, "utf8")).not.toContain("secret");
    expect(decrypt(record.encryptedError).stderr).toBe("secret-output");
    const snapshot = readFileSync(path, "utf8");
    const failSeal = () => {
      throw Error("secret-encryption-error");
    };
    expect(() =>
      deploymentExecutor(execute, retain, failSeal)("node", [], { env }),
    ).toThrow("WRANGLER_FAILED_DIAGNOSTIC_RETENTION_FAILED");
    expect(readFileSync(path, "utf8")).toBe(snapshot);
    expect(execute).toHaveBeenCalledTimes(2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
