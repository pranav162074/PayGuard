import fc from "fast-check";
import { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ensureAccounts,
  postEntry,
  reverseEntry,
  verifyLedger,
  type EntryInput,
  type LedgerDeps,
} from "../src/ledger/service.js";
import { captureLines, refundLines, settlementLines } from "../src/ledger/templates.js";
import { startTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let deps: LedgerDeps;
let merchantId: Types.ObjectId;
let counter = 0;

beforeAll(async () => {
  t = await startTestApp();
  deps = { mongo: t.mongo, models: t.app.locals.models };
});

afterAll(async () => {
  await t.close();
});

beforeEach(() => {
  // A fresh merchant per test keeps tests independent without dropping the database
  merchantId = new Types.ObjectId();
});

function entry(lines: EntryInput["lines"], overrides: Partial<EntryInput> = {}): EntryInput {
  counter += 1;
  return {
    merchantId,
    mode: "test",
    currency: "INR",
    description: `entry ${counter}`,
    idempotencyKey: `key-${counter}`,
    lines,
    ...overrides,
  };
}

async function balances(mode: "test" | "live" = "test", merchant = merchantId) {
  const accounts = await deps.models.LedgerAccount.find({ merchantId: merchant, mode }).lean();
  return Object.fromEntries(accounts.map((a) => [a.code, a.balance]));
}

describe("posting", () => {
  it("moves each account on its normal side and records running balances", async () => {
    const { entry: posted, created } = await postEntry(deps, entry(captureLines(10_000, 200)));
    await postEntry(deps, entry(captureLines(5_000, 100)));

    expect(created).toBe(true);
    expect(await balances()).toMatchObject({
      gateway_receivable: 15_000, // asset: debits increase it
      merchant_payable: 14_700, // liability: credits increase it
      fee_revenue: 300,
      bank: 0,
    });
    const postings = await deps.models.LedgerPosting.find({ entryId: posted._id }).lean();
    expect(postings.map((p) => p.balanceAfter).sort((a, b) => a - b)).toEqual([200, 9_800, 10_000]);
  });

  it.each([
    ["one line", [{ account: "bank", direction: "debit", amount: 100 }]],
    [
      "unbalanced",
      [
        { account: "bank", direction: "debit", amount: 100 },
        { account: "gateway_receivable", direction: "credit", amount: 99 },
      ],
    ],
    [
      "a fractional amount",
      [
        { account: "bank", direction: "debit", amount: 10.5 },
        { account: "gateway_receivable", direction: "credit", amount: 10.5 },
      ],
    ],
    [
      "a zero amount",
      [
        { account: "bank", direction: "debit", amount: 0 },
        { account: "gateway_receivable", direction: "credit", amount: 0 },
      ],
    ],
    [
      "an unknown account",
      [
        { account: "petty_cash", direction: "debit", amount: 100 },
        { account: "bank", direction: "credit", amount: 100 },
      ],
    ],
  ] as const)("refuses %s, and writes nothing", async (_, lines) => {
    await expect(postEntry(deps, entry([...lines]))).rejects.toMatchObject({
      code: "invalid_entry",
    });
    expect(await deps.models.LedgerEntry.countDocuments({ merchantId })).toBe(0);
  });

  it("keeps test and live mode, and merchants, apart", async () => {
    const other = new Types.ObjectId();
    await postEntry(deps, entry(captureLines(1_000, 0)));
    await postEntry(deps, entry(captureLines(2_000, 0), { mode: "live" }));
    await postEntry(deps, entry(captureLines(4_000, 0), { merchantId: other }));

    expect((await balances("test")).merchant_payable).toBe(1_000);
    expect((await balances("live")).merchant_payable).toBe(2_000);
    expect((await balances("test", other)).merchant_payable).toBe(4_000);
  });
});

describe("idempotency", () => {
  it("a retry returns the original entry instead of posting twice", async () => {
    const input = entry(captureLines(10_000, 0));

    const first = await postEntry(deps, input);
    const retry = await postEntry(deps, input);

    expect(retry.created).toBe(false);
    expect(retry.entry._id.toString()).toBe(first.entry._id.toString());
    expect((await balances()).merchant_payable).toBe(10_000);
  });

  it("ten simultaneous retries still post once", async () => {
    const input = entry(captureLines(10_000, 0));

    const results = await Promise.all(Array.from({ length: 10 }, () => postEntry(deps, input)));

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.entry._id.toString())).size).toBe(1);
    expect((await balances()).merchant_payable).toBe(10_000);
  });

  it("the same key with different content is refused", async () => {
    const input = entry(captureLines(10_000, 0));
    await postEntry(deps, input);

    await expect(
      postEntry(deps, { ...input, lines: captureLines(9_999, 0) }),
    ).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });
});

describe("balances that can't go negative", () => {
  it("a refund larger than the merchant's balance is refused, atomically", async () => {
    await postEntry(deps, entry(captureLines(1_000, 0)));

    await expect(postEntry(deps, entry(refundLines(1_001)))).rejects.toMatchObject({
      code: "insufficient_balance",
    });
    // Nothing from the failed entry stuck, not even the lines that would have succeeded
    expect(await balances()).toMatchObject({ merchant_payable: 1_000, gateway_receivable: 1_000 });
    expect(await deps.models.LedgerEntry.countDocuments({ merchantId })).toBe(1);
  });

  it("concurrent refunds can't spend the same money twice", async () => {
    await postEntry(deps, entry(captureLines(100, 0)));

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => postEntry(deps, entry(refundLines(30)))),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect((await balances()).merchant_payable).toBe(10);
    expect((await verifyLedger(deps.models, merchantId, "test")).balanced).toBe(true);
  });

  it("many concurrent postings to the same accounts all land exactly", async () => {
    await Promise.all(
      Array.from({ length: 50 }, () => postEntry(deps, entry(captureLines(1_000, 25)))),
    );

    expect(await balances()).toMatchObject({
      gateway_receivable: 50_000,
      merchant_payable: 48_750,
      fee_revenue: 1_250,
    });
  });
});

describe("reversals and immutability", () => {
  it("a reversal undoes an entry with a new one, once", async () => {
    const { entry: capture } = await postEntry(deps, entry(captureLines(10_000, 200)));

    const reversal = await reverseEntry(deps, merchantId, capture._id.toString());
    const again = await reverseEntry(deps, merchantId, capture._id.toString());

    expect(reversal.entry.reversalOf?.toString()).toBe(capture._id.toString());
    expect(again.created).toBe(false); // same idempotency key: the same reversal
    expect(await balances()).toMatchObject({
      gateway_receivable: 0,
      merchant_payable: 0,
      fee_revenue: 0,
    });
    // The original is still there, untouched: history is never rewritten
    expect(await deps.models.LedgerEntry.countDocuments({ merchantId })).toBe(2);
  });

  it("refuses to edit or delete entries and postings", async () => {
    const { entry: posted } = await postEntry(deps, entry(captureLines(100, 0)));

    await expect(
      deps.models.LedgerEntry.updateOne({ _id: posted._id }, { $set: { description: "edited" } }),
    ).rejects.toThrow(/immutable/);
    await expect(deps.models.LedgerEntry.deleteOne({ _id: posted._id })).rejects.toThrow(
      /immutable/,
    );
    await expect(deps.models.LedgerPosting.deleteMany({ entryId: posted._id })).rejects.toThrow(
      /immutable/,
    );
  });
});

describe("verification", () => {
  it("catches a cached balance that no longer matches the postings", async () => {
    await postEntry(deps, entry(captureLines(10_000, 0)));
    expect((await verifyLedger(deps.models, merchantId, "test")).balanced).toBe(true);

    // Someone edits a balance directly in the database
    await deps.models.LedgerAccount.collection.updateOne(
      { merchantId, mode: "test", code: "merchant_payable" },
      { $inc: { balance: 1 } },
    );
    const result = await verifyLedger(deps.models, merchantId, "test");

    expect(result.balanced).toBe(false);
    expect(result.mismatches).toEqual([
      { code: "merchant_payable", cached: 10_001, fromPostings: 10_000 },
    ]);
  });

  it("random sequences of captures, settlements and refunds always keep the books straight", async () => {
    const operation = fc.oneof(
      fc.record({
        kind: fc.constant("capture" as const),
        amount: fc.integer({ min: 1, max: 100_000 }),
        feeBp: fc.integer({ min: 0, max: 500 }),
      }),
      fc.record({
        kind: fc.constant("settle" as const),
        amount: fc.integer({ min: 1, max: 100_000 }),
      }),
      fc.record({
        kind: fc.constant("refund" as const),
        amount: fc.integer({ min: 1, max: 100_000 }),
      }),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(operation, { minLength: 1, maxLength: 15 }), async (operations) => {
        merchantId = new Types.ObjectId();
        await ensureAccounts(deps.models, merchantId, "test", "INR");
        // A simple in-memory model of what the balances should be
        const expected = { gateway_receivable: 0, bank: 0, merchant_payable: 0, fee_revenue: 0 };
        for (const op of operations) {
          if (op.kind === "capture") {
            const fee = Math.floor((op.amount * op.feeBp + 5_000) / 10_000);
            await postEntry(deps, entry(captureLines(op.amount, fee)));
            expected.gateway_receivable += op.amount;
            expected.merchant_payable += op.amount - fee;
            expected.fee_revenue += fee;
          } else if (op.kind === "settle") {
            // Settle what's outstanding, capped by the random amount
            const amount = Math.min(op.amount, expected.gateway_receivable);
            if (amount <= 0) continue;
            await postEntry(deps, entry(settlementLines(amount)));
            expected.gateway_receivable -= amount;
            expected.bank += amount;
          } else {
            const result = postEntry(deps, entry(refundLines(op.amount)));
            if (op.amount > expected.merchant_payable) {
              await expect(result).rejects.toMatchObject({ code: "insufficient_balance" });
              continue;
            }
            await result;
            expected.merchant_payable -= op.amount;
            expected.gateway_receivable -= op.amount;
          }
        }

        expect(await balances()).toMatchObject(expected);
        expect(expected.merchant_payable).toBeGreaterThanOrEqual(0);
        const audit = await verifyLedger(deps.models, merchantId, "test");
        expect(audit.balanced).toBe(true);
        expect(audit.totalDebits).toBe(audit.totalCredits);
      }),
      { numRuns: 25 },
    );
  });
});
