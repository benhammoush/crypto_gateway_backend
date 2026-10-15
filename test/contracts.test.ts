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
