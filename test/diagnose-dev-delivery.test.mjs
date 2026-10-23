import { expect, it, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { parse } from "yaml";
import { diagnoseDev } from "../scripts/diagnose-dev-delivery.mjs";
import { migrationDigest } from "../scripts/check-delivery.mjs";

const { Response, ReadableStream } = globalThis;

const version = "11111111-1111-4111-8111-111111111111";
const tokenId = "b".repeat(32);

/** Fixture target/configuration; no provider credential or network access. */
function environment() {
  const database = "22222222-2222-4222-8222-222222222222";
  return {
    GITHUB_REPOSITORY: "benhammoush/crypto_gateway_backend",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ATTEMPT: "1",
    CLOUDFLARE_ACCOUNT_ID: "86151fe132605d222017f191e4a1ee01",
    CLOUDFLARE_API_TOKEN: "synthetic-secret",
    D1_DATABASE_ID: database,
    OTHER_D1_DATABASE_ID: "33333333-3333-4333-8333-333333333333",
    D1_SCHEMA_DIGEST: migrationDigest(),
    API_ORIGIN: "https://dev.example.com",
    DEPLOY_ENABLED: "true",
    PAYMENTS_ENABLED: "true",
    GITHUB_TOKEN: "synthetic-github-secret",
    NODE_OPTIONS: "--inspect",
    RUNNER_TEMP: process.env.RUNNER_TEMP || process.env.TEMP,
    WORKER_CONFIG_JSON: JSON.stringify({
      name: "crypto-gateway-dev",
      main: "src/index.ts",
      compatibility_date: "2026-10-04",
      compatibility_flags: ["global_fetch_strictly_public"],
      workers_dev: true,
      d1_databases: [
        {
          binding: "DB",
          database_name: "crypto-gateway-dev",
          database_id: database,
          migrations_dir: "migrations",
        },
      ],
      triggers: { crons: ["* * * * *"] },
      vars: {
        APP_ENV: "dev",
        PAYMENTS_ENABLED: "true",
        CHECKOUT_ORIGIN: "https://checkout.example.com",
        WEBHOOK_HOSTS: "",
      },
    }),
  };
}

/** Serve only fixed GET metadata resources and prohibit all other requests. */
function metadata(env) {
  const account = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
  const worker = `${account}/workers/scripts/crypto-gateway-dev`;
  const history = {
    deployments: [{ versions: [{ version_id: version, percentage: 100 }] }],
  };
  const resources = new Map([
    [`${worker}/deployments`, history],
    [
      `${worker}/versions/${version}`,
      {
        resources: {
          bindings: [
            { name: "APP_ENV", text: "dev" },
            { name: "PAYMENTS_ENABLED", text: "true" },
            { name: "DB", id: env.D1_DATABASE_ID },
            { name: "SOLANA_RPC_URL", type: "secret_text" },
          ],
        },
      },
    ],
    [
      `${worker}/settings`,
      {
        bindings: [
          { name: "private-binding", text: "private-provider-payload" },
        ],
      },
    ],
    [`${account}/workers/subdomain`, { subdomain: "private-provider-payload" }],
    [
      `${account}/d1/database/${env.D1_DATABASE_ID}`,
      { uuid: env.D1_DATABASE_ID },
    ],
    [
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      { id: tokenId },
    ],
    [
      `https://api.cloudflare.com/client/v4/user/tokens/${tokenId}`,
      {
        policies: [
          {
            effect: "allow",
            permission_groups: [{ name: "Workers Scripts Write" }],
          },
        ],
      },
    ],
  ]);
  return vi.fn(async (url, init) => {
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers.authorization).toBe(
      `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    );
    expect(resources.has(url)).toBe(true);
    return Response.json({ success: true, result: resources.get(url) });
  });
}

it("observes enabled dev without mutations and exposes only fixed classifications", async () => {
  const env = environment();
  const fetcher = metadata(env);
  const execute = vi.fn((command, args, options) => {
    expect(command).toBe(process.execPath);
    expect(args).toContain("--dry-run");
    expect(args).toContain("--no-bundle");
    expect(args).not.toContain("--secrets-file");
    expect(
      JSON.parse(readFileSync(args[args.indexOf("--config") + 1])),
    ).toEqual(JSON.parse(env.WORKER_CONFIG_JSON));
    expect(options.env.CLOUDFLARE_API_TOKEN).toBeUndefined();
    expect(options.env.GITHUB_TOKEN).toBeUndefined();
    expect(options.env.NODE_OPTIONS).toBeUndefined();
    expect(options.env.HOME).toBe(options.cwd);
    expect(options.env.APPDATA).toBe(options.cwd);
    expect(options.env.XDG_CONFIG_HOME).toBe(options.cwd);
    expect(options.maxBuffer).toBe(1_048_576);
    expect(options.timeout).toBe(60_000);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    return {
      status: 0,
      stdout: "private-provider-payload",
      stderr: env.CLOUDFLARE_API_TOKEN,
    };
  });
  const report = await diagnoseDev(env, fetcher, execute);
  expect(report.readOnly).toBe(true);
  expect(report.packaging).toBe("DRY_RUN_OK");
  expect(report.runtimeConfigurationMatches).toBe(true);
  expect(report.rpcSecretObserved).toBe(true);
  expect(report.workerScriptWriteListed).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(7);
  expect(execute).toHaveBeenCalledOnce();
  expect(existsSync(execute.mock.calls[0][2].cwd)).toBe(false);
  expect(JSON.stringify(report)).not.toMatch(
    /synthetic-secret|private-provider-payload|private-binding|bbbbbbbb/,
  );
});

it("rejects unsafe contexts/configuration before reads or subprocesses", async () => {
  for (const patch of [
    { GITHUB_REPOSITORY: "other/repository" },
    { GITHUB_EVENT_NAME: "push" },
    { GITHUB_REF: "refs/heads/feature" },
    { GITHUB_SHA: "main" },
    { CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) },
    { CLOUDFLARE_API_TOKEN: "" },
    { OTHER_D1_DATABASE_ID: environment().D1_DATABASE_ID },
    { D1_DATABASE_ID: "../production" },
    { D1_SCHEMA_DIGEST: "b".repeat(64) },
    {
      WORKER_CONFIG_JSON: environment().WORKER_CONFIG_JSON.replace(
        "crypto-gateway-dev",
        "crypto-gateway-production",
      ),
    },
  ]) {
    const fetcher = vi.fn();
    const execute = vi.fn();
    await expect(
      diagnoseDev({ ...environment(), ...patch }, fetcher, execute),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  }
});

it("keeps denied API access, hidden policies and dry-run errors non-secret and inconclusive", async () => {
  const env = environment();
  const fetcher = vi.fn(async () =>
    Response.json(
      {
        success: false,
        errors: [
          { code: 10000, message: "private-provider-payload synthetic-secret" },
          { code: "synthetic-secret" },
        ],
      },
      { status: 403 },
    ),
  );
  const report = await diagnoseDev(
    env,
    fetcher,
    vi.fn(() => ({ status: 1, stderr: "synthetic-secret" })),
  );
  expect(report.checks.deployments).toEqual({
    status: "HTTP_403",
    codes: [10000],
  });
  expect(report.checks.accountTokenIdentity.status).toBe("HTTP_403");
  expect(report.workerScriptWriteListed).toBeNull();
  expect(report.packaging).toBe("DRY_RUN_FAILED");
  expect(fetcher).toHaveBeenCalledTimes(6);
  expect(JSON.stringify(report)).not.toMatch(
    /private-provider-payload|synthetic-secret/,
  );
});

it("bounds and cancels provider bodies without leaking malformed output or network exceptions", async () => {
  for (const kind of ["oversized", "malformed", "network"]) {
    let cancelled = false;
    const fetcher = vi.fn(async () => {
      if (kind === "network") throw Error("synthetic-secret");
      if (kind === "malformed") return new Response("synthetic-secret");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(65_537));
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    });
    const report = await diagnoseDev(
      environment(),
      fetcher,
      vi.fn(() => ({ status: 0 })),
    );
    expect(report.checks.deployments.status).toBe(
      kind === "oversized" ? "RESPONSE_TOO_LARGE" : "READ_FAILED",
    );
    if (kind === "oversized") expect(cancelled).toBe(true);
    expect(JSON.stringify(report)).not.toContain("synthetic-secret");
  }
});

it("never follows a provider-supplied version path outside the exact dev resource", async () => {
  const env = environment();
  const fetcher = metadata(env);
  fetcher.mockImplementationOnce(async () =>
    Response.json({
      success: true,
      result: {
        deployments: [{ versions: [{ version_id: "../../production" }] }],
      },
    }),
  );
  const report = await diagnoseDev(
    env,
    fetcher,
    vi.fn(() => ({ status: 0 })),
  );
  expect(report.checks.version).toBeUndefined();
  expect(fetcher.mock.calls.some(([url]) => url.includes("../"))).toBe(false);
});

it("fails safely from the CLI before credential access and never dumps exception data", () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("../scripts/diagnose-dev-delivery.mjs", import.meta.url),
      ),
    ],
    {
      env: {
        GITHUB_REPOSITORY: "untrusted/repo",
        CLOUDFLARE_API_TOKEN: "synthetic-secret",
      },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("UNSAFE_CONTEXT_OR_CONFIGURATION");
  expect(result.stdout + result.stderr).not.toMatch(
    /synthetic-secret|AssertionError|at diagnoseDev/,
  );
});

it("uses one manual main-only, dev-only read-only job without affecting CI or existing guards", () => {
  const workflow = parse(
    readFileSync(".github/workflows/diagnose-dev-delivery.yml", "utf8"),
  );
  expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  expect(workflow.permissions).toEqual({ contents: "read" });
  const job = workflow.jobs.diagnose;
  expect(job.if).toBe(
    "github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'",
  );
  expect(job.environment).toEqual({ name: "dev", deployment: false });
  expect(job["runs-on"]).toBe("ubuntu-24.04");
  expect(job.concurrency["cancel-in-progress"]).toBe(false);
  expect(job.concurrency.group).toBe(
    "deploy-${{ github.repository_owner }}-${{ github.event.repository.name }}-dev",
  );
  const privileged = job.steps.filter((step) => step.env?.CLOUDFLARE_API_TOKEN);
  expect(privileged).toHaveLength(1);
  expect(privileged[0].run).toBe("node scripts/diagnose-dev-delivery.mjs");
  expect(
    job.steps.filter((step) => step.run?.includes("npm ci"))[0].env,
  ).toBeUndefined();
  expect(
    job.steps.filter((step) => step.run?.includes("npm run build"))[0].env,
  ).toBeUndefined();
  expect(job.steps[0].with["persist-credentials"]).toBe(false);
  const source = readFileSync("scripts/diagnose-dev-delivery.mjs", "utf8");
  expect(source).not.toMatch(/method: "(?:POST|PUT|PATCH|DELETE)"/);
  expect(readFileSync("scripts/verify-dev.mjs", "utf8")).toContain(
    "PAYMENTS_MUST_REMAIN_DISABLED",
  );
});
