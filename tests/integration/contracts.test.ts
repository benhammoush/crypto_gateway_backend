/**
 * Runtime response compatibility with the published API schema.
 * @packageDocumentation
 */

import Ajv from "ajv/dist/2020";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const document = JSON.parse(readFileSync("openapi.json", "utf8"));
const ajv = new Ajv({ strict: true });
const schemas = JSON.parse(
  JSON.stringify(document.components.schemas).replaceAll(
    "#/components/schemas/",
    "#/$defs/",
  ),
);
ajv.addSchema({ $id: "gateway", $defs: schemas });

it("publishes a closed USD-only input contract and both credential boundaries", () => {
  const validate = ajv.compile({ $ref: "gateway#/$defs/CreatePayment" });
  expect(validate({ usdCents: 1000, merchantReference: "invoice-1" })).toBe(
    true,
  );
  expect(
    validate({
      usdCents: 1000,
      merchantReference: "invoice-1",
      recipient: "override",
    }),
  ).toBe(false);
  expect(validate({ usdCents: 1.5, merchantReference: "invoice-1" })).toBe(
    false,
  );
  expect(document.paths["/v1/payments"].post.security).toEqual([
    { merchantBearer: [] },
  ]);
  expect(document.paths["/v1/checkout/{id}"].get.security).toEqual([
    { checkoutBearer: [] },
  ]);
});

it("documents only authenticated, bounded read-only checkout RPC", () => {
  const validate = ajv.compile({ $ref: "gateway#/$defs/CheckoutRpcRequest" });
  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "getGenesisHash",
    params: [],
  };
  expect(validate(request)).toBe(true);
  expect(
    validate({
      ...request,
      method: "getLatestBlockhash",
      params: [{ commitment: "finalized" }],
    }),
  ).toBe(true);
  for (const invalid of [
    [request],
    { ...request, id: null },
    { ...request, method: "sendTransaction" },
    { ...request, upstream: "https://attacker.example.org" },
    {
      ...request,
      method: "getLatestBlockhash",
      params: [{ commitment: "processed" }],
    },
  ])
    expect(validate(invalid)).toBe(false);
  expect(document.paths["/v1/checkout/{id}/rpc"].post.security).toEqual([
    { checkoutBearer: [] },
  ]);
  const result = ajv.compile({ $ref: "gateway#/$defs/CheckoutRpcResult" });
  expect(
    result({
      jsonrpc: "2.0",
      id: 1,
      result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    }),
  ).toBe(true);
});
