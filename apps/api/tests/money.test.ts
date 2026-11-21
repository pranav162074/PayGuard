import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { allocate, feeFor, formatAmount, MoneyError, parseAmount } from "../src/ledger/money.js";

describe("money", () => {
  it("parses decimal strings without floating point", () => {
    expect(parseAmount("1234.5", "INR")).toBe(123450);
    expect(parseAmount("0.10", "INR")).toBe(10);
    // 0.1 + 0.2 in floating point is 0.30000000000000004; as paise it's exact
    expect(parseAmount("0.1", "INR") + parseAmount("0.2", "INR")).toBe(parseAmount("0.3", "INR"));
  });

  it.each(["1.234", "-5", "abc", "1e3", "", "0", "0.00", "99999999999999"])(
    "rejects %j",
    (value) => {
      expect(() => parseAmount(value, "INR")).toThrow(MoneyError);
    },
  );

  it("formats minor units", () => {
    expect(formatAmount(123450, "INR")).toBe("1234.50");
    expect(formatAmount(5, "INR")).toBe("0.05");
    expect(formatAmount(-250, "INR")).toBe("-2.50");
  });

  it("round-trips any amount through format and parse", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000_000_00 }), (amount) => {
        expect(parseAmount(formatAmount(amount, "INR"), "INR")).toBe(amount);
      }),
    );
  });

  it("rounds fees half up to the paisa", () => {
    expect(feeFor(10025, 200)).toBe(201); // 2% of ₹100.25 = 200.5 paise
    expect(feeFor(10000, 200)).toBe(200);
    expect(feeFor(1, 200)).toBe(0);
    expect(() => feeFor(100, 10_001)).toThrow(MoneyError);
  });

  it("allocates without losing or inventing a paisa", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(5, [70, 30])).toEqual([4, 1]);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc
          .array(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 10 })
          .filter((w) => w.some((x) => x > 0)),
        (amount, weights) => {
          const parts = allocate(amount, weights);
          expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
          // Each part is within one paisa of its exact share
          const total = weights.reduce((a, b) => a + b, 0);
          parts.forEach((part, i) => {
            expect(Math.abs(part - (amount * (weights[i] ?? 0)) / total)).toBeLessThan(1);
          });
        },
      ),
    );
  });
});
