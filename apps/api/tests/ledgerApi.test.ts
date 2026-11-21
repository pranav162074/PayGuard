import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { postEntry } from "../src/ledger/service.js";
import { captureLines, refundLines } from "../src/ledger/templates.js";
import { addMember, bearer, signup, startTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let n = 0;

afterEach(async () => {
  await t.close();
});

async function post(
  merchantId: string,
  lines: ReturnType<typeof captureLines>,
  mode: "test" | "live" = "test",
) {
  n += 1;
  return postEntry(
    { mongo: t.mongo, models: t.app.locals.models },
    {
      merchantId,
      mode,
      currency: "INR",
      description: `Payment ${n}`,
      idempotencyKey: `api-${n}`,
      lines,
    },
  );
}

describe("ledger API", () => {
  it("lists the chart of accounts with balances, per mode", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    await post(owner.merchantId, captureLines(10_000, 200));
    await post(owner.merchantId, captureLines(7_000, 0), "live");

    const test = await request(t.app).get("/v1/ledger/accounts").set(bearer(owner.accessToken));
    const live = await request(t.app)
      .get("/v1/ledger/accounts?mode=live")
      .set(bearer(owner.accessToken));

    expect(test.status).toBe(200);
    expect(test.body.accounts.map((a: { code: string }) => a.code)).toEqual([
      "gateway_receivable",
      "bank",
      "merchant_payable",
      "fee_revenue",
    ]);
    const payable = (body: { accounts: { code: string; balance: number }[] }) =>
      body.accounts.find((a) => a.code === "merchant_payable")?.balance;
    expect(payable(test.body)).toBe(9_800);
    expect(payable(live.body)).toBe(7_000);
  });

  it("an API key sees only its own mode", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    await post(owner.merchantId, captureLines(7_000, 0), "live");
    const { key } = (
      await request(t.app)
        .post("/v1/api-keys")
        .set(bearer(owner.accessToken))
        .send({ name: "s", mode: "test" })
    ).body;

    const res = await request(t.app).get("/v1/ledger/accounts?mode=live").set(bearer(key));

    expect(res.body.mode).toBe("test");
    expect(res.body.accounts.every((a: { balance: number }) => a.balance === 0)).toBe(true);
  });

  it("pages through an account statement with running balances", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    for (let i = 0; i < 5; i += 1) await post(owner.merchantId, captureLines(1_000, 0));
    await post(owner.merchantId, refundLines(500));

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await request(t.app)
        .get("/v1/ledger/accounts/merchant_payable/postings")
        .query({ limit: 4, ...(cursor ? { cursor } : {}) })
        .set(bearer(owner.accessToken));
      seen.push(...res.body.postings.map((p: { balanceAfter: number }) => p.balanceAfter));
      cursor = res.body.nextCursor as string | null;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(2);
    // Newest first: the refund, then the five captures
    expect(seen).toEqual([4_500, 5_000, 4_000, 3_000, 2_000, 1_000]);
  });

  it("shows entries only to their merchant, and audits the books", async () => {
    t = await startTestApp();
    const shopA = await signup(t.app);
    const shopB = await signup(t.app);
    const { entry } = await post(shopA.merchantId, captureLines(10_000, 200));

    const own = await request(t.app)
      .get(`/v1/ledger/entries/${entry._id.toString()}`)
      .set(bearer(shopA.accessToken));
    const other = await request(t.app)
      .get(`/v1/ledger/entries/${entry._id.toString()}`)
      .set(bearer(shopB.accessToken));
    const audit = await request(t.app).get("/v1/ledger/verify").set(bearer(shopA.accessToken));

    expect(own.body.lines).toEqual([
      { account: "gateway_receivable", direction: "debit", amount: 10_000 },
      { account: "merchant_payable", direction: "credit", amount: 9_800 },
      { account: "fee_revenue", direction: "credit", amount: 200 },
    ]);
    expect(other.status).toBe(404);
    expect(audit.body).toMatchObject({ balanced: true, totalDebits: 10_000, totalCredits: 10_000 });
  });

  it("is readable by analysts, and rejects bad input", async () => {
    t = await startTestApp();
    const owner = await signup(t.app);
    const analyst = await addMember(t.app, owner, "analyst");

    const read = await request(t.app).get("/v1/ledger/accounts").set(bearer(analyst.accessToken));
    const badMode = await request(t.app)
      .get("/v1/ledger/accounts?mode=prod")
      .set(bearer(owner.accessToken));
    const badCursor = await request(t.app)
      .get("/v1/ledger/accounts/merchant_payable/postings?cursor=nope")
      .set(bearer(owner.accessToken));
    const noAccount = await request(t.app)
      .get("/v1/ledger/accounts/petty_cash/postings")
      .set(bearer(owner.accessToken));

    expect(read.status).toBe(200);
    expect(badMode.status).toBe(422);
    expect(badCursor.status).toBe(422);
    expect(noAccount.status).toBe(404);
  });
});
