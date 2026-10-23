import { expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyDeploymentError,
  deploymentExecutor,
  retainDeploymentFailure,
} from "../scripts/deployment-error.mjs";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    writeFileSync: vi.fn(original.writeFileSync),
    renameSync: vi.fn(original.renameSync),
  };
});

it("preserves the original checkpoint and removes temporary files on write or rename failure", () => {
  for (const operation of [writeFileSync, renameSync]) {
    const directory = mkdtempSync(join(tmpdir(), "gateway-atomic-test-"));
    try {
      const path = join(directory, "delivery-record.json");
      const original =
        '{"status":"mutation-requested","previousDeploymentId":"prior"}\n';
      writeFileSync(path, original);
      vi.mocked(operation).mockImplementationOnce(() => {
        throw Error("simulated filesystem failure");
      });
      expect(() =>
        retainDeploymentFailure(classifyDeploymentError({ status: 1 }), path),
      ).toThrow("simulated filesystem failure");
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readdirSync(directory)).toEqual(["delivery-record.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

it("retains only fixed classifications from errors containing credentials and provider responses", () => {
  const error = Object.assign(new Error("secret command and credential"), {
    stdout: "secret-token [code: 10000] [code: 10000] [code: 123456]",
    stderr:
      "Authentication error [code: 9109] https://private.example/key\nUnable to fetch bindings, routes, or services metadata from the dashboard",
    status: 1,
    code: "secret-process-code",
    signal: "secret-signal",
    env: { CLOUDFLARE_API_TOKEN: "secret-token" },
  });
  expect(classifyDeploymentError(error)).toEqual({
    stage: "WRANGLER_SUBPROCESS",
    exitCode: 1,
    processCode: "UNCLASSIFIED",
    providerCodes: [9109, 10000],
    moduleNotFound: false,
    dashboardMetadataFailure: true,
    authenticationFailure: true,
  });
  expect(JSON.stringify(classifyDeploymentError(error))).not.toMatch(
    /secret|private|123456/,
  );
});

it("bounds output and ignores arbitrary numbers, messages, buffers and invalid statuses", () => {
  for (const error of [
    null,
    {},
    { status: -1 },
    { status: 999 },
    { status: "1", code: "secret" },
  ]) {
    expect(classifyDeploymentError(error).exitCode).toBeNull();
    expect(classifyDeploymentError(error).providerCodes).toEqual([]);
  }
  expect(
    classifyDeploymentError({ stderr: "x".repeat(1_048_576) + "[code: 10000]" })
      .providerCodes,
  ).toEqual([]);
  expect(
    classifyDeploymentError({ stderr: "token=10000 code 9109" }).providerCodes,
  ).toEqual([]);
  expect(
    classifyDeploymentError({
      code: "ETIMEDOUT",
      stderr: "Error: Cannot find module '/private/path'",
    }),
  ).toMatchObject({ processCode: "ETIMEDOUT", moduleNotFound: true });
});

it("passes successful calls through unchanged, with no extra calls or evidence mutation", () => {
  const execute = vi.fn(() => "captured output");
  const retain = vi.fn();
  const args = [
    "node",
    ["wrangler", "deploy"],
    { env: { SECRET: "fixture" }, stdio: ["ignore", "pipe", "pipe"] },
  ];
  expect(deploymentExecutor(execute, retain)(...args)).toBe("captured output");
  expect(execute).toHaveBeenCalledExactlyOnceWith(...args);
  expect(retain).not.toHaveBeenCalled();
});

it("does not retry or expose the original error, including when evidence persistence fails", () => {
  for (const retentionFails of [false, true]) {
    const execute = vi.fn(() => {
      throw Object.assign(new Error("secret-original"), {
        stderr: "secret-output",
        status: 1,
      });
    });
    const retain = vi.fn(() => {
      if (retentionFails) throw Error("secret-path");
    });
    try {
      deploymentExecutor(execute, retain)("node", [], {
        env: { CI_ENVIRONMENT: "dev", SECRET: "secret-token" },
      });
      throw Error("expected failure");
    } catch (error) {
      expect(error.message).toBe(
        retentionFails
          ? "WRANGLER_FAILED_DIAGNOSTIC_RETENTION_FAILED"
          : "WRANGLER_FAILED_INSPECT_RETAINED_CLASSIFICATION",
      );
      expect(error.cause).toBeUndefined();
      expect(JSON.stringify(error)).not.toContain("secret");
    }
    expect(execute).toHaveBeenCalledOnce();
    expect(retain).toHaveBeenCalledExactlyOnceWith(
      classifyDeploymentError({ status: 1 }),
    );
  }
});

it("adds classifications without upgrading uncertain status or changing recovery identities", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-error-test-"));
  try {
    const path = join(directory, "delivery-record.json");
    const original = {
      sourceSha: "a".repeat(40),
      status: "mutation-requested",
      deploymentId: null,
      previousDeploymentId: "prior-worker",
      previousProviderDeploymentId: "prior-deployment",
    };
    writeFileSync(path, JSON.stringify(original));
    const diagnostic = classifyDeploymentError({
      status: 1,
      stderr: "[code: 10000]",
    });
    retainDeploymentFailure(diagnostic, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      ...original,
      failure: diagnostic,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("wires only the subprocess executor into the existing pinned deployment and retained artifact", () => {
  const adapter = readFileSync("scripts/ci-deploy.mjs", "utf8");
  expect(adapter).toContain("deploymentExecutor()");
  expect(adapter).toContain("await smokeDelivery(process.env, fetcher)");
  expect(readFileSync(".github/workflows/ci.yml", "utf8")).toContain(
    "37151e604a66c0dbb68b5631534c7124d4d95798",
  );
});
