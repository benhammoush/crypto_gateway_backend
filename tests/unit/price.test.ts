import { expect, it } from "vitest";
import { formatSol, lamportsForUsd } from "../../src/price";

it("uses exact upward rounding, including exponent notation", () => {
  expect(lamportsForUsd(100, "3")).toBe("333333334");
  expect(lamportsForUsd(100, "1.5025e2")).toBe(lamportsForUsd(100, "150.25"));
  expect(formatSol("1000000001")).toBe("1.000000001");
});

it.each(["0", "-1", "Infinity", "1e999999", "0.0000000000000000000000000001"])(
  "rejects invalid or unsupported price %s",
  (price) => {
    expect(() => lamportsForUsd(100, price)).toThrow();
  },
);

it.each([0, -1, 1.2, 1_000_001])("rejects invalid USD cents %s", (cents) => {
  expect(() => lamportsForUsd(cents, "150")).toThrow();
});
