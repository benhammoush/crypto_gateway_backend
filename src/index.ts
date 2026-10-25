/**
 * Gateway HTTP routing and scheduled verification/webhook delivery.
 * @packageDocumentation
 */

import { config, ConfigurationError } from "./config";
import { checkoutRpc } from "./checkout-rpc";
import {
  checkoutToken,
  createPayment,
  getPayment,
  paymentView,
  retryVerification,
  submit,
} from "./payments";
import { base58Length, bearer, equal, jsonBody, sha256 } from "./security";
import { Config, Env, PublicError } from "./types";
import { deliverWebhooks } from "./webhooks";

/** Consume the database-backed request budget for this identity.
 * @param db - Selected environment's database binding.
 * @param identity - Rate-limit identity scoped to the authenticated operation.
 * @param limit - Maximum requests allowed in the current minute window.
 */
async function rateLimit(
  db: D1Database,
  identity: string,
  limit: number,
): Promise<void> {
  const bucket = Math.floor(Date.now() / 60_000);
  const key = await sha256(`${identity}:${bucket}`);
  const result = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = count + 1 RETURNING count`,
    )
    .bind(key, (bucket + 2) * 60_000)
    .first<{ count: number }>();
  if (!result || result.count > limit)
    throw new PublicError(
      "RATE_LIMITED",
      "Too many requests. Try again shortly.",
      429,
    );
}

/** Build a JSON response with request correlation and allowed-origin headers.
 * @param data - Public response envelope, never raw provider or credential data.
 * @param requestId - Correlation identifier for this request.
 * @param origin - Browser origin supplied by the request, if present.
 * @param allowed - Configured origin permitted to read this response.
 * @param status - HTTP response status.
 * @returns A non-cacheable JSON response with scoped CORS headers.
 */
function response(
  data: unknown,
  requestId: string,
  origin: string | null,
  allowed: string | undefined,
  status = 200,
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-request-id": requestId,
      ...(origin === allowed
        ? {
            "access-control-allow-origin": origin,
            vary: "Origin",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers":
              "Authorization, Content-Type, Idempotency-Key, Solana-Client",
          }
        : {}),
    },
  });
}

export default {
  /** Validate configuration, authenticate and dispatch the incoming gateway request.
   * @param request - Incoming HTTP request at the gateway boundary.
   * @param env - Selected environment's bindings and configuration.
   * @returns A public response with credentials and upstream details withheld.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const origin = request.headers.get("origin");
    let settings: Config | undefined;
    try {
      const path = new URL(request.url).pathname;
      if (path === "/health" && request.method === "GET") {
        return response(
          {
            data: { service: "crypto_gateway_backend", version: "0.2.1" },
            meta: { requestId },
          },
          requestId,
          origin,
          undefined,
        );
      }
      try {
        settings = config(env);
      } catch (error) {
        if (
          env.APP_ENV === "dev" &&
          path === "/ready" &&
          request.method === "GET" &&
          error instanceof ConfigurationError
        ) {
          return response(
            {
              error: {
                code: "NOT_CONFIGURED",
                message: "Gateway configuration is incomplete.",
                requestId,
                diagnostic: error.diagnostic,
              },
            },
            requestId,
            origin,
            undefined,
            503,
          );
        }
        throw new PublicError(
          "NOT_CONFIGURED",
          "Gateway configuration is incomplete.",
          503,
        );
      }
      if (origin && origin !== settings.checkoutOrigin)
        throw new PublicError(
          "ORIGIN_REJECTED",
          "Browser origin is not approved.",
          403,
        );
      if (request.method === "OPTIONS")
        return response({}, requestId, origin, settings.checkoutOrigin);
      if (path === "/ready" && request.method === "GET") {
        return response(
          {
            data: {
              ready: settings.enabled,
              environment: settings.environment,
              network: "solana-devnet",
            },
            meta: { requestId },
          },
          requestId,
          origin,
          settings.checkoutOrigin,
          settings.enabled ? 200 : 503,
        );
      }
      if (!settings.enabled)
        throw new PublicError(
          "PAYMENTS_DISABLED",
          "Payment processing is disabled.",
          503,
        );
      await rateLimit(
        env.DB,
        `ip:${request.headers.get("cf-connecting-ip") ?? "local"}`,
        180,
      );
      const credential = bearer(request);
      let data: unknown;
      if (path.startsWith("/v1/payments")) {
        const digest = await sha256(credential);
        const merchant = settings.merchants.find((entry) =>
          equal(entry.apiKeyHash, digest),
        );
        if (!merchant)
          throw new PublicError(
            "UNAUTHORIZED",
            "Invalid merchant credential.",
            401,
          );
        await rateLimit(env.DB, `merchant:${merchant.id}`, 120);
        if (path === "/v1/payments" && request.method === "POST") {
          data = await createPayment(
            env.DB,
            settings,
            merchant,
            await jsonBody(request),
            request.headers.get("idempotency-key") ?? "",
          );
        } else {
          const match = /^\/v1\/payments\/([a-f0-9-]{36})$/.exec(path);
          if (!match || request.method !== "GET")
            throw new PublicError("NOT_FOUND", "Endpoint was not found.", 404);
          const payment = await getPayment(env.DB, match[1]);
          if (payment.merchant_id !== merchant.id)
            throw new PublicError("NOT_FOUND", "Payment was not found.", 404);
          data = await paymentView(env.DB, settings, payment, true);
        }
      } else {
        const match =
          /^\/v1\/checkout\/([a-f0-9-]{36})(\/transactions|\/rpc)?$/.exec(path);
        if (
          !match ||
          (match[2] ? request.method !== "POST" : request.method !== "GET")
        )
          throw new PublicError("NOT_FOUND", "Endpoint was not found.", 404);
        const payment = await getPayment(env.DB, match[1]);
        if (!equal(credential, await checkoutToken(settings, payment)))
          throw new PublicError(
            "UNAUTHORIZED",
            "Invalid checkout session.",
            401,
          );
        await rateLimit(env.DB, `checkout:${payment.id}`, 60);
        if (match[2] === "/rpc") {
          await rateLimit(env.DB, `rpc:${payment.id}`, 12);
          await rateLimit(env.DB, "rpc:global", 60);
          return response(
            await checkoutRpc(settings.rpc, payment, await jsonBody(request)),
            requestId,
            origin,
            settings.checkoutOrigin,
          );
        }
        if (match[2]) {
          const body = await jsonBody(request);
          if (
            Object.keys(body).length !== 1 ||
            typeof body.signature !== "string" ||
            base58Length(body.signature) !== 64
          ) {
            throw new PublicError(
              "INVALID_SIGNATURE",
              "Supply a valid transaction signature.",
            );
          }
          await submit(env.DB, settings, payment, body.signature);
        }
        data = await paymentView(
          env.DB,
          settings,
          await getPayment(env.DB, payment.id),
        );
      }
      return response(
        { data, meta: { requestId } },
        requestId,
        origin,
        settings.checkoutOrigin,
      );
    } catch (error) {
      const safe =
        error instanceof PublicError
          ? error
          : new PublicError(
              "INTERNAL_ERROR",
              "The request could not be completed.",
              500,
            );
      return response(
        { error: { code: safe.code, message: safe.message, requestId } },
        requestId,
        origin,
        settings?.checkoutOrigin,
        safe.status,
      );
    }
  },
  /** Retry durable settlement candidates and pending webhook deliveries.
   * @param _event - Platform cron event; retry eligibility comes from persisted state.
   * @param env - Selected environment's database and gateway configuration.
   */
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const settings = config(env);
    if (!settings.enabled) return;
    await retryVerification(env.DB, settings);
    await deliverWebhooks(env.DB, settings);
    await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?")
      .bind(Date.now())
      .run();
  },
};
