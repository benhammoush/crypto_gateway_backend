import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  bootstrapConfig,
  bootstrapDev,
  runBootstrapCommand,
} from "../scripts/bootstrap-dev.mjs";
import { deliveryConfig, migrationDigest } from "../scripts/check-delivery.mjs";
import { smokeDelivery } from "../scripts/smoke-delivery.mjs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

/** Synthetic first-dev state; no network or real credentials are used. */
function fixture() {
  const id = "11111111-1111-4111-8111-111111111111";
  const workerId = "b".repeat(32);
  const versionId = "c".repeat(32);
  const config = {
    name: "crypto-gateway-dev",
    main: "src/index.ts",
    compatibility_date: "2026-10-04",
    compatibility_flags: ["global_fetch_strictly_public"],
    workers_dev: true,
    d1_databases: [
      {
        binding: "DB",
        database_name: "crypto-gateway-dev",
        database_id: id,
        migrations_dir: "migrations",
      },
    ],
    triggers: { crons: ["* * * * *"] },
    vars: {
      APP_ENV: "dev",
      PAYMENTS_ENABLED: "false",
      CHECKOUT_ORIGIN: "https://checkout.example.com",
      SOLANA_RPC_URL: "https://api.devnet.solana.com",
      WEBHOOK_HOSTS: "",
    },
  };
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_SHA: "a".repeat(40),
    SOURCE_SHA: "a".repeat(40),
    DELIVERY_TARGET: "dev",
    PAYMENTS_ENABLED: "false",
    CONFIRM_FIRST_DEV_DEPLOYMENT: "true",
    EXPECTED_WORKER_ID: workerId,
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    CLOUDFLARE_API_TOKEN: "synthetic-read",
    CLOUDFLARE_WORKER_BOOTSTRAP_TOKEN: "synthetic-write",
    D1_DATABASE_ID: id,
    OTHER_D1_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
    D1_SCHEMA_DIGEST: migrationDigest(),
    API_ORIGIN: "https://api.example.com",
    WORKER_CONFIG_JSON: JSON.stringify(config),
  };
  const references = Object.fromEntries(
    [
      "domains",
      "queues",
      "workers",
      "durable_objects",
      "dispatch_namespace_outbounds",
    ].map((key) => [key, []]),
  );
  let executed = 0;
  const calls = [];
  const records = [];
  const dependencies = {
    inspect: async () => ({
      sourceSha: env.SOURCE_SHA,
      databaseIdentityMatched: true,
      schemaState: "definitions-and-records-match",
      migrationTablePresent: true,
      expectedMigrationSetDigest: env.D1_SCHEMA_DIGEST,
    }),
    execute: async () => {
      executed++;
      return true;
    },
    smoke: async () => ({
      configurationSmokeVerified: true,
      paymentsEnabled: false,
    }),
    record: (record) => records.push(record),
    fetcher: async (url, options) => {
      calls.push({ url, options });
      expect(options.method).toBe("GET");
      expect(options.redirect).toBe("error");
      expect(options.headers.authorization).toBe("Bearer synthetic-write");
      let result;
      let info;
      if (url.endsWith("deployments"))
        result = {
          deployments: [
            {
              id: "d".repeat(32),
              versions: [{ version_id: versionId, percentage: 100 }],
            },
          ],
        };
      else if (url.includes("/versions?")) {
        result = executed ? [{ id: versionId }] : [];
        info = {
          page: 1,
          per_page: 100,
          count: result.length,
          total_count: result.length,
        };
      } else
        result = {
          id: workerId,
          name: "crypto-gateway-dev",
          references,
          subdomain: {
            url: env.API_ORIGIN,
            enabled: executed > 0,
            previews_enabled: false,
          },
        };
      return globalThis.Response.json({
        success: true,
        result,
        ...(info ? { result_info: info } : {}),
      });
    },
  };
  return {
    env,
    config,
    dependencies,
    calls,
    records,
    executions: () => executed,
  };
}

describe("explicit first dev bootstrap", () => {
  it.each([undefined, "false", "true"])(
    "ignores obsolete deploy flag %s but requires empty-version inventory and one verified mutation",
    async (enabled) => {
      const f = fixture();
      f.env.DEPLOY_ENABLED = enabled;
      expect(deliveryConfig.bind(null, f.env, migrationDigest())).not.toThrow();
      expect(bootstrapConfig(f.env).preview_urls).toBe(false);
      expect(
        (await bootstrapDev(f.env, f.dependencies)).bootstrapVerified,
      ).toBe(true);
      expect(f.executions()).toBe(1);
      expect(f.records.some((row) => row.deploymentId)).toBe(true);
      expect(f.calls.some((row) => row.url.includes("workers/workers/"))).toBe(
        true,
      );
    },
  );
  it.each([
    ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_RUN_ATTEMPT", "2"],
    ["GITHUB_REF", "refs/heads/feature"],
    ["GITHUB_ACTIONS", "false"],
    ["SOURCE_SHA", "e".repeat(40)],
    ["CONFIRM_FIRST_DEV_DEPLOYMENT", "false"],
    ["DELIVERY_TARGET", "production"],
    ["PAYMENTS_ENABLED", "true"],
    ["EXPECTED_WORKER_ID", ""],
    ["CLOUDFLARE_WORKER_BOOTSTRAP_TOKEN", ""],
    ["D1_SCHEMA_DIGEST", ""],
  ])("rejects %s before any provider call or mutation", async (key, value) => {
    const f = fixture();
    f.env[key] = value;
    await expect(bootstrapDev(f.env, f.dependencies)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(f.executions()).toBe(0);
  });
  it("rejects enabled runtime payments and shared database IDs", () => {
    const f = fixture();
    f.config.vars.PAYMENTS_ENABLED = "true";
    f.env.WORKER_CONFIG_JSON = JSON.stringify(f.config);
    expect(() => bootstrapConfig(f.env)).toThrow();
    const g = fixture();
    g.env.OTHER_D1_DATABASE_ID = g.env.D1_DATABASE_ID;
    expect(() => bootstrapConfig(g.env)).toThrow();
  });
  it.each([401, 403, 404, 500])(
    "never converts HTTP %s to empty-history proof",
    async (status) => {
      const f = fixture();
      f.dependencies.fetcher = async () =>
        new globalThis.Response("private-provider-body", { status });
      await expect(bootstrapDev(f.env, f.dependencies)).rejects.toThrow();
      expect(f.executions()).toBe(0);
    },
  );
  it.each([
    "versions",
    "identity",
    "references",
    "pagination",
    "schema",
    "oversize",
    "malformed",
  ])("stops on invalid preflight %s", async (kind) => {
    const f = fixture();
    const read = f.dependencies.fetcher;
    f.dependencies.fetcher = async (...args) => {
      if (kind === "oversize")
        return new globalThis.Response("x".repeat(65_537));
      if (kind === "malformed") return new globalThis.Response("not json");
      const original = await read(...args);
      const body = await original.json();
      if (args[0].includes("/versions?")) {
        if (kind === "versions") body.result.push({ id: "existing-version" });
        if (kind === "pagination") body.result_info.total_count = 1;
      } else {
        if (kind === "identity") body.result.name = "crypto-gateway-production";
        if (kind === "references")
          body.result.references.workers.push({ name: "another" });
      }
      return globalThis.Response.json(body);
    };
    if (kind === "schema")
      f.dependencies.inspect = async () => ({
        schemaState: "application-schema-absent",
      });
    await expect(bootstrapDev(f.env, f.dependencies)).rejects.toThrow();
    expect(f.executions()).toBe(0);
  });
  it("never retries uncertain deployment, even when all subsequent checks pass", async () => {
    const f = fixture();
    const execute = f.dependencies.execute;
    f.dependencies.execute = async () => {
      await execute();
      throw Error("uncertain private output");
    };
    const result = await bootstrapDev(f.env, f.dependencies);
    expect(f.executions()).toBe(1);
    expect(result.commandCompleted).toBe(false);
    expect(result.bootstrapVerified).toBe(false);
  });
  it("retains observed deployment identity if a later smoke check fails", async () => {
    const f = fixture();
    f.dependencies.smoke = async () => {
      throw Error("smoke failure");
    };
    expect((await bootstrapDev(f.env, f.dependencies)).bootstrapVerified).toBe(
      false,
    );
    expect(f.records.some((row) => row.deploymentId)).toBe(true);
    expect(f.executions()).toBe(1);
  });
  it("uses pinned Wrangler with explicit source-root config and only the bootstrap token", () => {
    const f = fixture();
    let calls = 0;
    expect(
      runBootstrapCommand(
        f.env,
        bootstrapConfig(f.env),
        (_node, args, options) => {
          calls++;
          expect(args.slice(1, 3)).toEqual(["deploy", "--config"]);
          const managed = JSON.parse(readFileSync(args[3], "utf8"));
          expect(managed.account_id).toBe(f.env.CLOUDFLARE_ACCOUNT_ID);
          expect(managed.vars.PAYMENTS_ENABLED).toBe("false");
          expect(options.env.CLOUDFLARE_API_TOKEN).toBe("synthetic-write");
          return { status: 0 };
        },
      ),
    ).toBe(true);
    expect(calls).toBe(1);
    expect(existsSync("wrangler.bootstrap.json")).toBe(false);
  });
  it("retires the one-time first-Worker workflow entry point", () => {
    expect(existsSync(".github/workflows/bootstrap-dev.yml")).toBe(false);
  });
});

describe("configuration smoke is not payment activation", () => {
  it.each([false, true])(
    "checks exact enabled=%s readiness status/body",
    async (enabled) => {
      const f = fixture();
      f.config.vars.PAYMENTS_ENABLED = String(enabled);
      f.env.WORKER_CONFIG_JSON = JSON.stringify(f.config);
      const result = await smokeDelivery(f.env, async (url, options) => {
        expect(options.method).toBe("GET");
        expect(options.redirect).toBe("error");
        return globalThis.Response.json(
          {
            data: url.endsWith("/health")
              ? { service: "crypto_gateway_backend", version }
              : {
                  ready: enabled,
                  environment: "dev",
                  network: "solana-devnet",
                },
          },
          { status: url.endsWith("/health") || enabled ? 200 : 503 },
        );
      });
      expect(result.paymentsEnabled).toBe(enabled);
    },
  );
  it.each([
    "generic-503",
    "ready-true",
    "wrong-network",
    "wrong-version",
    "wrong-status",
  ])(
    "rejects %s instead of treating it as disabled readiness",
    async (kind) => {
      const f = fixture();
      await expect(
        smokeDelivery(f.env, async (url) => {
          const health = url.endsWith("/health");
          const data = health
            ? {
                service: "crypto_gateway_backend",
                version: kind === "wrong-version" ? "wrong" : version,
              }
            : {
                ready: kind === "ready-true",
                environment: "dev",
                network: kind === "wrong-network" ? "mainnet" : "solana-devnet",
              };
          return globalThis.Response.json(
            !health && kind === "generic-503"
              ? { error: { code: "NOT_CONFIGURED" } }
              : { data },
            { status: health || kind === "wrong-status" ? 200 : 503 },
          );
        }),
      ).rejects.toThrow();
    },
  );
});
