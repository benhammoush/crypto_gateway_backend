import { describe, expect, it } from "vitest";
// Delivery tooling is JavaScript executed directly by Node in CI.
import { deliveryConfig, migrationDigest } from "../scripts/check-delivery.mjs";
import { readFileSync } from "node:fs";

/** Create public synthetic configuration without provider access. */
function fixture() {
  const id = "11111111-1111-4111-8111-111111111111";
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
  return {
    config,
    env: {
      DEPLOY_ENABLED: "true",
      GITHUB_REF: "refs/heads/main",
      SOURCE_SHA: "a".repeat(40),
      DELIVERY_TARGET: "dev",
      GITHUB_EVENT_NAME: "push",
      GITHUB_RUN_ATTEMPT: "1",
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_API_TOKEN: "synthetic",
      D1_DATABASE_ID: id,
      OTHER_D1_DATABASE_ID: "22222222-2222-4222-8222-222222222222",
      D1_SCHEMA_DIGEST: migrationDigest(),
      API_ORIGIN: "https://api.example.com",
      WORKER_CONFIG_JSON: JSON.stringify(config),
    },
  };
}

describe("manual production delivery guard", () => {
  it("accepts explicit isolated dev configuration without querying or mutating providers", () => {
    const { env, config } = fixture();
    expect(deliveryConfig(env, migrationDigest())).toEqual(config);
  });
  it("rejects disabled, non-main, unreviewed schema, shared D1 and unsafe target settings", () => {
    for (const [key, value] of [
      ["DEPLOY_ENABLED", "false"],
      ["GITHUB_REF", "refs/heads/feature"],
      ["SOURCE_SHA", "main"],
      ["DELIVERY_TARGET", "staging"],
      ["GITHUB_EVENT_NAME", "pull_request"],
      ["D1_SCHEMA_DIGEST", ""],
      ["CLOUDFLARE_API_TOKEN", ""],
      ["OTHER_D1_DATABASE_ID", "11111111-1111-4111-8111-111111111111"],
    ]) {
      const { env } = fixture();
      expect(() =>
        deliveryConfig({ ...env, [key]: value }, migrationDigest()),
      ).toThrow();
    }
    for (const change of [
      { main: "other.ts" },
      { name: "crypto-gateway-production" },
      { env: { production: {} } },
      { vars: { APP_ENV: "local" } },
      { d1_databases: [] },
      { triggers: { crons: [] } },
    ]) {
      const { env, config } = fixture();
      env.WORKER_CONFIG_JSON = JSON.stringify({ ...config, ...change });
      expect(() => deliveryConfig(env, migrationDigest())).toThrow();
    }
  });
  it("requires a new manual dispatch for production", () => {
    const { env, config } = fixture();
    config.name = "crypto-gateway-production";
    config.vars.APP_ENV = "production";
    config.d1_databases[0].database_name = "crypto-gateway-production";
    env.DELIVERY_TARGET = "production";
    env.WORKER_CONFIG_JSON = JSON.stringify(config);
    expect(() => deliveryConfig(env, migrationDigest())).toThrow();
    env.GITHUB_EVENT_NAME = "workflow_dispatch";
    expect(() => deliveryConfig(env, migrationDigest())).not.toThrow();
    env.GITHUB_RUN_ATTEMPT = "2";
    expect(() => deliveryConfig(env, migrationDigest())).toThrow();
  });
  it("gates deployment behind existing checks and never applies hosted migrations", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("needs: [source, quality]");
    expect(workflow).toContain("environment: ${{ inputs.target || 'dev' }}");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("git merge-base --is-ancestor");
    expect(workflow).not.toContain("migrations apply");
    expect(workflow).not.toContain("VERCEL_DEV_VERIFICATION_TOKEN");
  });
});
