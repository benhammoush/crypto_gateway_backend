import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { verifyDev } from "../scripts/verify-dev.mjs";
const { Response, AbortSignal } = globalThis;
afterEach(() => vi.restoreAllMocks());

/** Synthetic configuration; no provider credentials or calls. */
function environment() {
  return {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "a".repeat(40),
    PAYMENTS_ENABLED: "false",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
    CLOUDFLARE_API_TOKEN: "synthetic-secret",
  };
}

/** Return only fixture metadata from the two permitted read endpoints. */
function provider(env) {
  return vi.fn(async (url, init) => {
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers.authorization).toBe(
      `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    );
    expect(init.body).toBeUndefined();
    const account = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
    if (url === `${account}/d1/database/${env.D1_DATABASE_ID}`)
      return Response.json({
        success: true,
        result: { uuid: env.D1_DATABASE_ID, name: "crypto-gateway-dev" },
      });
    expect(url).toBe(
      `${account}/workers/scripts/crypto-gateway-dev/deployments`,
    );
    return Response.json({ success: true, result: { deployments: [] } });
  });
}

it.each([undefined, "false", "true"])(
  "ignores obsolete deploy flag %s and reads only exact dev metadata",
  async (enabled) => {
    const env = { ...environment(), DEPLOY_ENABLED: enabled };
    const fetcher = provider(env);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    expect(await verifyDev(env, fetcher)).toEqual({
      sourceSha: env.GITHUB_SHA,
      databaseIdentityMatched: true,
      workerDeploymentListingReadable: true,
      deploymentEntriesObserved: 0,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(15_000);
  },
);

it("cancels oversized response streams", async () => {
  let cancelled = false;
  const stream = new globalThis.ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(65_537));
    },
    cancel() {
      cancelled = true;
    },
  });
  await expect(
    verifyDev(
      environment(),
      vi.fn(async () => new Response(stream)),
    ),
  ).rejects.toThrow("D1_METADATA_RESPONSE_TOO_LARGE");
  expect(cancelled).toBe(true);
});

it("never prints network errors or secrets from the CLI", () => {
  const module = new URL("../scripts/verify-dev.mjs", import.meta.url);
  const source = `process.argv[1] = ${JSON.stringify(fileURLToPath(module))}; globalThis.fetch = async () => { throw new Error('private-provider-payload synthetic-secret'); }; await import(${JSON.stringify(module.href)});`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { env: environment(), encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("VERIFICATION_FAILED");
  expect(result.stdout + result.stderr).not.toMatch(
    /private-provider-payload|synthetic-secret/,
  );
});

it("rejects nonmanual/nonmain, activation and malformed identities before network access", async () => {
  for (const [key, value] of [
    ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_REF", "refs/heads/feature"],
    ["GITHUB_SHA", "main"],
    ["PAYMENTS_ENABLED", "true"],
    ["CLOUDFLARE_ACCOUNT_ID", "../production"],
    ["D1_DATABASE_ID", "../production"],
    ["CLOUDFLARE_API_TOKEN", ""],
  ]) {
    const fetcher = vi.fn();
    await expect(
      verifyDev({ ...environment(), [key]: value }, fetcher),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  }
});

it("rejects mismatched D1 identity and never continues to worker inspection", async () => {
  for (const result of [
    null,
    { uuid: environment().D1_DATABASE_ID, name: "crypto-gateway-production" },
    { uuid: "other", name: "crypto-gateway-dev" },
  ]) {
    const fetcher = vi.fn(async () => Response.json({ success: true, result }));
    await expect(verifyDev(environment(), fetcher)).rejects.toThrow(
      "D1_IDENTITY_MISMATCH",
    );
    expect(fetcher).toHaveBeenCalledOnce();
  }
});

it.each([401, 403, 404, 429, 500])(
  "never treats HTTP %s as empty history or retries inspection",
  async (status) => {
    const env = environment();
    const fetcher = provider(env)
      .mockImplementationOnce(async () =>
        Response.json({
          success: true,
          result: { uuid: env.D1_DATABASE_ID, name: "crypto-gateway-dev" },
        }),
      )
      .mockImplementationOnce(
        async () => new Response("private provider payload", { status }),
      );
    await expect(verifyDev(env, fetcher)).rejects.toThrow(
      `WORKER_DEPLOYMENTS_HTTP_${status}`,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it("rejects oversized and malformed metadata", async () => {
  for (const response of [
    Response.json({ success: false, errors: ["private provider payload"] }),
    new Response("x".repeat(65_537)),
  ]) {
    await expect(
      verifyDev(
        environment(),
        vi.fn(async () => response),
      ),
    ).rejects.toThrow();
  }
  const fetcher = provider(environment());
  fetcher.mockImplementationOnce(async () =>
    Response.json({
      success: true,
      result: {
        uuid: environment().D1_DATABASE_ID,
        name: "crypto-gateway-dev",
      },
    }),
  );
  fetcher.mockImplementationOnce(async () =>
    Response.json({ success: true, result: {} }),
  );
  await expect(verifyDev(environment(), fetcher)).rejects.toThrow(
    "WORKER_DEPLOYMENTS_RESPONSE_INVALID",
  );
});

it("retires the old access-verification workflow entry point", () => {
  expect(() => readFileSync(".github/workflows/verify-dev.yml")).toThrow(
    expect.objectContaining({ code: "ENOENT" }),
  );
});
