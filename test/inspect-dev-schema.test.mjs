import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import {
  CATALOG_SQL,
  MIGRATIONS_SQL,
  expectedSchema,
  inspectDevSchema,
} from "../scripts/inspect-dev-schema.mjs";
const { Response, AbortSignal } = globalThis;
afterEach(() => vi.restoreAllMocks());

/** Synthetic environment; never inherit provider credentials. */
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

/** Simulated Wrangler migration tracking table, never queried outside fixtures. */
const migrationTable = {
  type: "table",
  name: "d1_migrations",
  tbl_name: "d1_migrations",
  sql: "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT)",
};

/** Return a read-only D1 query envelope with no application data. */
function queryResponse(results, meta = {}) {
  return Response.json({
    success: true,
    result: [
      {
        success: true,
        results,
        meta: { changed_db: false, changes: 0, rows_written: 0, ...meta },
      },
    ],
  });
}

/** Mock only metadata GET and the two source-defined SELECT requests. */
function provider(catalog = [], records = []) {
  const env = environment();
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/d1/database/${env.D1_DATABASE_ID}`;
  return vi.fn(async (url, init) => {
    expect(init.headers.authorization).toBe(
      `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
    );
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url === endpoint) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      return Response.json({
        success: true,
        result: { uuid: env.D1_DATABASE_ID, name: "crypto-gateway-dev" },
      });
    }
    expect(url).toBe(`${endpoint}/query`);
    expect(init.method).toBe("POST");
    const { sql, ...extra } = JSON.parse(init.body);
    expect(extra).toEqual({});
    expect([CATALOG_SQL, MIGRATIONS_SQL]).toContain(sql);
    expect(sql).toMatch(/^SELECT /);
    expect(sql).not.toMatch(/FROM (payments|attempts|events|rate_limits)\b/i);
    return queryResponse(sql === CATALOG_SQL ? catalog : records);
  });
}

it.each([undefined, "false", "true"])(
  "ignores obsolete deploy flag %s and inspects schema without payment rows",
  async (enabled) => {
    const fetcher = provider();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const result = await inspectDevSchema(
      { ...environment(), DEPLOY_ENABLED: enabled },
      fetcher,
    );
    expect(result).toMatchObject({
      schemaState: "application-schema-absent",
      migrationTablePresent: false,
      observedApplicationObjectCount: 0,
      recordedExpectedMigrations: [],
      schemaAttestationRecorded: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  },
);

it("compares source-derived definitions and expected migration names without attesting or mutating", async () => {
  const source = expectedSchema();
  const fetcher = provider(
    [...source.definitions, migrationTable],
    source.files.map((name) => ({ name, privateField: "do not print" })),
  );
  const result = await inspectDevSchema(environment(), fetcher);
  expect(result).toMatchObject({
    schemaState: "definitions-and-records-match",
    recordedExpectedMigrations: source.files,
    expectedMigrationSetDigest: source.digest,
    schemaAttestationRecorded: false,
  });
  expect(JSON.stringify(result)).not.toMatch(
    /privateField|do not print|CREATE TABLE/,
  );
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("keeps missing/inconsistent migration history distinct from schema acceptance", async () => {
  const source = expectedSchema();
  expect(
    await inspectDevSchema(environment(), provider(source.definitions)),
  ).toHaveProperty("schemaState", "definitions-present-records-incomplete");
  expect(
    await inspectDevSchema(
      environment(),
      provider(
        [migrationTable],
        source.files.map((name) => ({ name })),
      ),
    ),
  ).toHaveProperty("schemaState", "records-without-application-schema");
  expect(
    await inspectDevSchema(environment(), provider([migrationTable])),
  ).toMatchObject({
    schemaState: "application-schema-absent",
    migrationTablePresent: true,
  });
});

it("rejects incomplete, rewritten, unexpected or malformed catalog definitions", async () => {
  const { definitions } = expectedSchema();
  for (const catalog of [
    definitions.slice(1),
    definitions.map((row, i) =>
      i === 0 ? { ...row, sql: row.sql + " -- changed" } : row,
    ),
    [
      ...definitions,
      {
        type: "table",
        name: "private-provider-payload",
        tbl_name: "other",
        sql: "CREATE TABLE other (value TEXT)",
      },
    ],
    [...definitions, definitions[0]],
    [{ type: "table", name: "payments", tbl_name: "payments", sql: null }],
  ]) {
    const fetcher = provider(catalog);
    await expect(inspectDevSchema(environment(), fetcher)).rejects.toThrow(
      /CATALOG_RESPONSE_INVALID|APPLICATION_SCHEMA_REVIEW_REQUIRED/,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  }
});

it("never queries a view masquerading as migration records", async () => {
  const fetcher = provider([
    {
      ...migrationTable,
      type: "view",
      sql: "CREATE VIEW d1_migrations AS SELECT name FROM payments",
    },
  ]);
  await expect(inspectDevSchema(environment(), fetcher)).rejects.toThrow(
    "MIGRATION_TABLE_NOT_A_TABLE",
  );
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("rejects unexpected, duplicate or malformed migration record names without reflecting them", async () => {
  for (const records of [
    [{ name: "private-provider-payload" }],
    [{ name: 42 }],
    [{ name: "0001_payments.sql" }, { name: "0001_payments.sql" }],
  ]) {
    await expect(
      inspectDevSchema(environment(), provider([migrationTable], records)),
    ).rejects.toThrow("MIGRATION_RECORDS_REVIEW_REQUIRED");
  }
});

it("rejects unsafe context before any provider access", async () => {
  for (const [key, value] of [
    ["GITHUB_EVENT_NAME", "push"],
    ["GITHUB_REF", "refs/heads/feature"],
    ["GITHUB_SHA", "main"],
    ["PAYMENTS_ENABLED", "true"],
    ["CLOUDFLARE_ACCOUNT_ID", "../other"],
    ["D1_DATABASE_ID", "../other"],
    ["CLOUDFLARE_API_TOKEN", ""],
  ]) {
    const fetcher = vi.fn();
    await expect(
      inspectDevSchema({ ...environment(), [key]: value }, fetcher),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  }
});

it("verifies exact dev database metadata before issuing any SELECT", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      success: true,
      result: {
        uuid: environment().D1_DATABASE_ID,
        name: "crypto-gateway-production",
      },
    }),
  );
  await expect(inspectDevSchema(environment(), fetcher)).rejects.toThrow(
    "D1_IDENTITY_MISMATCH",
  );
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([401, 403, 404, 429, 500])(
  "stops on query HTTP %s without retrying or echoing the response",
  async (status) => {
    const fetcher = provider()
      .mockImplementationOnce(async () =>
        Response.json({
          success: true,
          result: {
            uuid: environment().D1_DATABASE_ID,
            name: "crypto-gateway-dev",
          },
        }),
      )
      .mockImplementationOnce(
        async () => new Response("private-provider-payload", { status }),
      );
    await expect(inspectDevSchema(environment(), fetcher)).rejects.toThrow(
      `SCHEMA_QUERY_HTTP_${status}`,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);

it("rejects reported writes, missing write metrics, excess rows and malformed query results", async () => {
  for (const response of [
    queryResponse([], { changed_db: true }),
    queryResponse([], { rows_written: 1 }),
    queryResponse([], { changes: 1 }),
    Response.json({
      success: true,
      result: [{ success: true, results: [], meta: {} }],
    }),
    queryResponse(new Array(129).fill({})),
    Response.json({ success: true, result: [] }),
    Response.json({ success: true, result: [{ success: false, results: [] }] }),
  ]) {
    const fetcher = provider()
      .mockImplementationOnce(async () =>
        Response.json({
          success: true,
          result: {
            uuid: environment().D1_DATABASE_ID,
            name: "crypto-gateway-dev",
          },
        }),
      )
      .mockImplementationOnce(async () => response);
    await expect(inspectDevSchema(environment(), fetcher)).rejects.toThrow(
      /QUERY_WRITE_METRICS_NOT_READ_ONLY|CATALOG_LIMIT_EXCEEDED|QUERY_RESPONSE_INVALID/,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  }
});

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
    inspectDevSchema(
      environment(),
      vi.fn(async () => new Response(stream)),
    ),
  ).rejects.toThrow("D1_METADATA_RESPONSE_TOO_LARGE");
  expect(cancelled).toBe(true);
});

it("never prints raw network errors or secrets through the CLI", () => {
  const module = new URL("../scripts/inspect-dev-schema.mjs", import.meta.url);
  const source = `process.argv[1] = ${JSON.stringify(fileURLToPath(module))}; globalThis.fetch = async () => { throw new Error('private-provider-payload synthetic-secret'); }; await import(${JSON.stringify(module.href)});`;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { env: environment(), encoding: "utf8" },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("INSPECTION_FAILED");
  expect(result.stdout + result.stderr).not.toMatch(
    /private-provider-payload|synthetic-secret/,
  );
});

it("retires the hosted schema-inspection entry point without removing the CLI", () => {
  expect(() =>
    readFileSync(".github/workflows/inspect-dev-schema.yml"),
  ).toThrow(expect.objectContaining({ code: "ENOENT" }));
});
