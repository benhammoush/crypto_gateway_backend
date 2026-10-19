import { expect, it, vi } from "vitest";
import { smokeConfig, smokeDelivery } from "../scripts/smoke-delivery.mjs";

const env = {
  API_ORIGIN: "https://crypto-gateway-dev.benhxm.workers.dev",
  WORKER_CONFIG_JSON: JSON.stringify({
    vars: { APP_ENV: "dev", PAYMENTS_ENABLED: "false" },
  }),
  GATEWAY_ACCESS_CI_CLIENT_ID: "fixture-ci-id",
  GATEWAY_ACCESS_CI_CLIENT_SECRET: "fixture-ci-secret",
};
it.each([
  { GATEWAY_ACCESS_CI_CLIENT_ID: "" },
  { GATEWAY_ACCESS_CI_CLIENT_SECRET: "" },
  { API_ORIGIN: "https://evil.example" },
  { API_ORIGIN: "https://crypto-gateway-dev.benhxm.workers.dev/path" },
])("fails private preflight before network access: %j", async (extra) => {
  const fetcher = vi.fn();
  await expect(smokeDelivery({ ...env, ...extra }, fetcher)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
it("never sends dev credentials during production smoke", () => {
  const production = {
    ...env,
    API_ORIGIN: "https://production.example",
    WORKER_CONFIG_JSON: JSON.stringify({
      vars: { APP_ENV: "production", PAYMENTS_ENABLED: "false" },
    }),
  };
  expect(() => smokeConfig(production)).toThrow();
  const config = smokeConfig({
    ...production,
    GATEWAY_ACCESS_CI_CLIENT_ID: "",
    GATEWAY_ACCESS_CI_CLIENT_SECRET: "",
  });
  expect(config.headers).toEqual({});
});
it.each(["html", "redirect", "network"])(
  "rejects %s without retry or accepting a login page",
  async (kind) => {
    const fetcher = vi.fn(async (url, options) => {
      expect(url).toBe(`${env.API_ORIGIN}/health`);
      expect(options.headers).toEqual({
        "CF-Access-Client-Id": "fixture-ci-id",
        "CF-Access-Client-Secret": "fixture-ci-secret",
      });
      expect(options.redirect).toBe("error");
      if (kind === "network") throw new Error("fixture-ci-secret");
      return new globalThis.Response(
        kind === "html" ? "<title>Login</title>" : "{}",
        { status: kind === "html" ? 200 : 302 },
      );
    });
    await expect(smokeDelivery(env, fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
