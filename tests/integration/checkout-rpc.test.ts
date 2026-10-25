/**
 * Checkout RPC authentication, allowlisting and provider isolation regressions.
 * @packageDocumentation
 */

import { afterEach, expect, it, vi } from "vitest";
import { checkoutRpc } from "../../src/checkout-rpc";
import type { Payment } from "../../src/types";

const url = "https://rpc.example.org/?api-key=server-only-fixture";
const genesis = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const payment = {
  signature: null,
  expires_at: Date.now() + 900_000,
} as Payment;
const input = {
  jsonrpc: "2.0",
  id: "wallet-1",
  method: "getGenesisHash",
  params: [],
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("uses only the configured upstream and canonical arguments without forwarding credentials", async () => {
  const fetchMock = vi.fn(() =>
    Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, result: genesis })),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(await checkoutRpc(url, payment, input)).toEqual({
    jsonrpc: "2.0",
    id: "wallet-1",
    result: genesis,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    url,
    expect.objectContaining({
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getGenesisHash",
        params: [],
      }),
    }),
  );
});

it.each([
  { method: "sendTransaction" },
  { method: "getTransaction" },
  { params: ["https://attacker.example.org"] },
  { url: "https://attacker.example.org" },
  { id: null },
  { id: "x".repeat(65) },
  { jsonrpc: "1.0" },
  { params: undefined },
  { method: "getLatestBlockhash", params: [{ commitment: "processed" }] },
  {
    method: "getLatestBlockhash",
    params: [{ commitment: "finalized", minContextSlot: 1 }],
  },
])("rejects unsupported input without fetching: %j", async (overrides) => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    checkoutRpc(url, payment, { ...input, ...overrides }),
  ).rejects.toMatchObject({ code: "INVALID_RPC_REQUEST" });
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([{ signature: "settled" }, { expires_at: Date.now() - 1 }])(
  "rejects inactive payment %j",
  async (overrides) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      checkoutRpc(url, { ...payment, ...overrides }, input),
    ).rejects.toMatchObject({ code: "NOT_PAYABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  },
);

it("returns only validated blockhash fields", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 123, provider: url },
            value: {
              blockhash: "1".repeat(32),
              lastValidBlockHeight: 99,
              secret: url,
            },
          },
        }),
      ),
    ),
  );
  expect(
    await checkoutRpc(url, payment, {
      ...input,
      method: "getLatestBlockhash",
      params: [{ commitment: "finalized" }],
    }),
  ).toEqual({
    jsonrpc: "2.0",
    id: input.id,
    result: {
      context: { slot: 123 },
      value: { blockhash: "1".repeat(32), lastValidBlockHeight: 99 },
    },
  });
});

it.each([
  {
    context: { slot: -1 },
    value: { blockhash: "1".repeat(32), lastValidBlockHeight: 99 },
  },
  {
    context: { slot: 1 },
    value: { blockhash: "invalid", lastValidBlockHeight: 99 },
  },
  {
    context: { slot: 1 },
    value: {
      blockhash: "1".repeat(32),
      lastValidBlockHeight: Number.MAX_SAFE_INTEGER + 1,
    },
  },
])("rejects invalid blockhash result %j", async (result) => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(Response.json({ jsonrpc: "2.0", id: 1, result })),
  );
  await expect(
    checkoutRpc(url, payment, {
      ...input,
      method: "getLatestBlockhash",
      params: [{ commitment: "finalized" }],
    }),
  ).rejects.toMatchObject({ code: "RPC_UNAVAILABLE" });
});

it("bounds the upstream deadline and sanitizes timeouts", async () => {
  const deadline = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockReturnValue(deadline.signal);
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new Error(url)), {
            once: true,
          });
        }),
    ),
  );
  const pending = expect(
    checkoutRpc(url, payment, input),
  ).rejects.toMatchObject({ code: "RPC_UNAVAILABLE" });
  expect(timeout).toHaveBeenCalledWith(8000);
  deadline.abort();
  await pending;
});

it.each([
  () => Response.json({ jsonrpc: "2.0", id: 1, result: "mainnet" }),
  () => Response.json({ jsonrpc: "2.0", id: 2, result: genesis }),
  () => Response.json({ error: { message: url } }, { status: 403 }),
  () => new Response(null, { status: 302, headers: { location: url } }),
  () =>
    new Response("x".repeat(4097), {
      headers: { "content-type": "application/json" },
    }),
  () =>
    Response.json({
      jsonrpc: "2.0",
      id: 1,
      result: { value: { blockhash: "invalid" } },
    }),
  () => {
    throw new Error(url);
  },
])(
  "sanitizes provider failure without disclosing the key %#",
  async (reply) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve().then(reply)),
    );
    await expect(checkoutRpc(url, payment, input)).rejects.toMatchObject({
      code: "RPC_UNAVAILABLE",
      message: "Solana verification is temporarily unavailable.",
    });
  },
);
