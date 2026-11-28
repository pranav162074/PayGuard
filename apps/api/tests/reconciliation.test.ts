import { Queue } from "bullmq";
import { Redis } from "ioredis";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { signPayment } from "../src/gateway/razorpay.js";
import { createLogger } from "../src/logger.js";
import { createGateways } from "../src/payments/checkout.js";
import type { PaymentIntent } from "../src/payments/models.js";
import type { ReconMismatch } from "../src/reconciliation/models.js";
import {
  RECON_QUEUE,
  reconcileDay,
  startReconciliationScheduler,
} from "../src/reconciliation/schedule.js";
import {
  dayWindow,
  previousIstDay,
  runReconciliation,
  type ReconDeps,
} from "../src/reconciliation/service.js";
import { FakeRazorpay } from "./fakeRazorpay.js";
import { addMember, bearer, signup, startTestApp, testConfig, type TestApp } from "./helpers.js";

const KEYS = { keyId: "rzp_test_Fake1234", keySecret: "fake_key_secret_123" };
const DAY = "2026-11-27";
// Noon in India on DAY, as unix seconds: inside the day's window
const NOON = dayWindow(DAY).from + 12 * 3600;

let t: TestApp;
let rzp: FakeRazorpay;
let started = false;

afterEach(async () => {
  if (started) await t.close();
  started = false;
});

async function start(): Promise<void> {
  rzp = new FakeRazorpay(KEYS.keyId, KEYS.keySecret);
  rzp.clock = () => NOON;
  t = await startTestApp({
    razorpayFetch: rzp.fetch,
    config: {
      razorpay: {
        test: KEYS,
        webhookSecret: null,
        live: null,
        apiUrl: "https://api.razorpay.test/v1",
      },
      checkoutUrl: "https://pay.example.com",
    },
  });
  started = true;
}

function deps(): ReconDeps {
  return {
    mongo: t.mongo,
    models: t.app.locals.models,
    feeBasisPoints: t.config.platformFeeBps,
    gateways: createGateways(t.config, rzp.fetch),
    logger: createLogger("silent"),
  };
}

const reconcile = (extra: Partial<Parameters<typeof runReconciliation>[1]> = {}) =>
  runReconciliation(deps(), {
    mode: "test",
    date: DAY,
    now: new Date((NOON + 86_400) * 1000),
    ...extra,
  });

async function merchant(name = "Chai Point") {
  const owner = await signup(t.app, { businessName: name });
  const created = await request(t.app)
    .post("/v1/api-keys")
    .set(bearer(owner.accessToken))
    .send({ name: "server", mode: "test" });
  return { owner, key: created.body.key as string };
}

/** Opens the hosted checkout, so the intent gets a Razorpay order. */
async function withOrder(key: string, amount: number) {
  const created = await request(t.app)
    .post("/v1/payment_intents")
    .set(bearer(key))
    .send({ amount });
  const opened = await request(t.app)
    .get(`/v1/checkout/${created.body.id}`)
    .query({ client_secret: created.body.client_secret });
  return {
    id: created.body.id as string,
    secret: created.body.client_secret as string,
    orderId: opened.body.razorpay.order_id as string,
  };
}

/** A payment made on Razorpay's checkout, confirmed with us; its time is the fake's clock. */
async function paid(key: string, amount: number) {
  const { id, secret, orderId } = await withOrder(key, amount);
  const payment = rzp.pay(orderId);
  const confirmed = await request(t.app)
    .post(`/v1/checkout/${id}/confirm`)
    .send({
      client_secret: secret,
      razorpay_order_id: orderId,
      razorpay_payment_id: payment.id,
      razorpay_signature: signPayment(KEYS.keySecret, orderId, payment.id),
    });
  expect(confirmed.body.status).toBe("succeeded");
  // Our side records when it happened: put it in the same day
  await t.app.locals.models.PaymentIntent.updateOne(
    { _id: id },
    { $set: { succeededAt: new Date(NOON * 1000) } },
  );
  return { id, paymentId: payment.id };
}

async function balances(token: string): Promise<Record<string, number>> {
  const res = await request(t.app).get("/v1/ledger/accounts").set(bearer(token));
  return Object.fromEntries(
    (res.body.accounts as { code: string; balance: number }[]).map((a) => [a.code, a.balance]),
  );
}

const mismatches = (filter: Record<string, unknown> = {}) =>
  t.app.locals.models.ReconMismatch.find(filter).lean<ReconMismatch[]>();

describe("a clean day", () => {
  it("matches every payment, posts the settlement once, and the ledger balances", async () => {
    await start();
    const { owner, key } = await merchant();
    const a = await paid(key, 50_000);
    const b = await paid(key, 30_000);
    const refunded = await request(t.app)
      .post(`/v1/payment_intents/${a.id}/refunds`)
      .set(bearer(key))
      .send({ amount: 10_000 });
    const [rzpRefund] = rzp.refundsOf(a.paymentId);
    const settlementId = rzp.settle(DAY, {
      payments: [a.paymentId, b.paymentId],
      refunds: [rzpRefund?.id as string],
    });

    const run = await reconcile();

    expect(refunded.body.status).toBe("succeeded");
    expect(run).toMatchObject({
      status: "completed",
      attempts: 1,
      counts: { gatewayPayments: 2, matched: 2, settlements: 1, settlementLines: 3, mismatches: 0 },
    });
    expect(await mismatches()).toEqual([]);
    // 80,000 captured, 10,000 refunded; Razorpay keeps 2% + 18% GST on the payments
    const fees = 1000 + 600;
    const tax = 180 + 108;
    expect(await balances(owner.accessToken)).toMatchObject({
      gateway_receivable: 0,
      bank: 70_000 - fees - tax,
      gateway_fees: fees + tax,
    });
    const verify = await request(t.app).get("/v1/ledger/verify").set(bearer(owner.accessToken));
    expect(verify.body.balanced).toBe(true);
    const settlement = await request(t.app)
      .get(`/v1/settlements/${settlementId}`)
      .set(bearer(owner.accessToken));
    expect(settlement.body).toMatchObject({
      payments: 80_000,
      refunds: 10_000,
      gateway_fees: fees,
      gateway_tax: tax,
      net: 70_000 - fees - tax,
      lines: 3,
    });
    const intent = await t.app.locals.models.PaymentIntent.findById(a.id).lean<PaymentIntent>();
    expect(intent?.gateway?.settlementId).toBe(settlementId);

    // Again: same run, nothing posted twice
    const again = await reconcile();
    expect(again._id).toBe(run._id);
    expect(again.attempts).toBe(2);
    expect(await balances(owner.accessToken)).toMatchObject({ bank: 70_000 - fees - tax });
    const runs = await request(t.app).get("/v1/reconciliation/runs").set(bearer(owner.accessToken));
    expect(runs.body.data).toEqual([
      expect.objectContaining({
        date: DAY,
        status: "completed",
        summary: expect.objectContaining({
          matched: 2,
          mismatches: 0,
          gateway_amount: 80_000,
          ledger_amount: 80_000,
          difference: 0,
          settled_net: 70_000 - fees - tax,
        }),
      }),
    ]);
  });
});

describe("what it catches", () => {
  it("syncs a capture we never heard about", async () => {
    await start();
    const { key } = await merchant();
    // The customer paid; the browser closed before confirming, and no webhook came
    const { id, orderId } = await withOrder(key, 40_000);
    rzp.pay(orderId);

    const run = await reconcile();

    const intent = await t.app.locals.models.PaymentIntent.findById(id).lean<PaymentIntent>();
    expect(intent?.status).toBe("succeeded");
    expect(run.counts).toMatchObject({ autoFixed: 1, mismatches: 0 });
    expect(await mismatches()).toEqual([
      expect.objectContaining({ type: "late_capture", status: "resolved", resolution: "auto" }),
    ]);
  });

  it("flags differing amounts, refunds, and payments Razorpay doesn't have", async () => {
    await start();
    const { owner, key } = await merchant();
    const wrongAmount = await paid(key, 50_000);
    const extraRefund = await paid(key, 20_000);
    const vanished = await paid(key, 10_000);
    await paid(key, 5_000); // fine
    const gateway = (id: string) => rzp.payments.get(id);
    const p = gateway(wrongAmount.paymentId);
    if (p) p.amount = 45_000;
    // Refunded in Razorpay's dashboard, not through us
    rzp.refunds.set("rfnd_dashboard", {
      id: "rfnd_dashboard",
      payment_id: extraRefund.paymentId,
      amount: 2_000,
      currency: "INR",
      status: "processed",
      notes: [],
    });
    const v = gateway(vanished.paymentId);
    if (v) v.status = "failed";
    // A capture on the account that isn't ours at all
    rzp.payments.set("pay_stranger", {
      id: "pay_stranger",
      order_id: null,
      amount: 999,
      currency: "INR",
      status: "captured",
      method: "card",
      error_code: null,
      error_description: null,
      created_at: NOON,
    });

    const run = await reconcile();
    const found = await mismatches({ status: "open" });

    expect(found.map((m) => m.type).sort()).toEqual([
      "amount_mismatch",
      "missing_at_gateway",
      "refund_mismatch",
      "unknown_at_gateway",
    ]);
    expect(found.find((m) => m.type === "amount_mismatch")).toMatchObject({
      paymentIntentId: wrongAmount.id,
      expected: { amount: 50_000 },
      actual: { amount: 45_000 },
      message: "Razorpay captured ₹450.00; the payment was for ₹500.00",
    });
    expect(found.find((m) => m.type === "unknown_at_gateway")?.merchantId).toBeNull();
    expect(run.counts).toMatchObject({ gatewayPayments: 4, matched: 1, mismatches: 4 });

    // The merchant sees theirs, not the one no merchant owns
    const listed = await request(t.app)
      .get("/v1/reconciliation/mismatches?status=open")
      .set(bearer(owner.accessToken));
    expect(listed.body.data).toHaveLength(3);
    const detail = await request(t.app)
      .get(`/v1/reconciliation/runs/${run._id}`)
      .set(bearer(owner.accessToken));
    expect(detail.body.mismatches_by_type).toEqual({
      amount_mismatch: { open: 1, total: 1 },
      missing_at_gateway: { open: 1, total: 1 },
      refund_mismatch: { open: 1, total: 1 },
    });
    expect(detail.body.summary.difference).toBe(-5_000 - 10_000);
  });

  it("checks settlement lines and takes adjustments to a person", async () => {
    await start();
    const { owner, key } = await merchant();
    const a = await paid(key, 50_000);
    rzp.settle(DAY, { payments: [a.paymentId], adjustments: [{ debit: 1_500 }] });
    const lines = rzp.recon.get(DAY) ?? [];
    const line = lines.find((l) => l.entity_id === a.paymentId);
    if (line) line.amount = 49_000;

    await reconcile();
    const types = (await mismatches({ status: "open" })).map((m) => m.type).sort();

    expect(types).toEqual(["adjustment", "settlement_amount_mismatch"]);
    // The settlement is still posted, with what Razorpay actually paid for
    expect((await balances(owner.accessToken)).gateway_receivable).toBe(50_000 - 49_000);
  });

  it("can't post a settlement that would take the bank negative", async () => {
    await start();
    const { owner, key } = await merchant();
    const a = await paid(key, 50_000);
    await request(t.app)
      .post(`/v1/payment_intents/${a.id}/refunds`)
      .set(bearer(key))
      .send({ amount: 20_000 });
    // Only the refund settles today: Razorpay takes money back, and the bank has none
    rzp.settle(DAY, { refunds: [rzp.refundsOf(a.paymentId)[0]?.id as string] });

    await reconcile();

    expect(await mismatches({ type: "ledger_rejected" })).toEqual([
      expect.objectContaining({ status: "open", merchantId: expect.anything() }),
    ]);
    expect((await balances(owner.accessToken)).bank).toBe(0);
  });

  it("flags live payments that stay unsettled, and clears them once settled", async () => {
    await start();
    const { key } = await merchant();
    const a = await paid(key, 50_000);
    const later = new Date((NOON + 5 * 86_400) * 1000);

    await reconcile({ now: later, checkOverdue: true });
    expect(await mismatches({ type: "settlement_overdue", status: "open" })).toHaveLength(1);

    rzp.settle("2026-12-01", { payments: [a.paymentId] });
    await runReconciliation(deps(), {
      mode: "test",
      date: "2026-12-01",
      now: later,
      checkOverdue: true,
    });
    expect(await mismatches({ type: "settlement_overdue", status: "open" })).toEqual([]);
  });
});

describe("resolving mismatches", () => {
  it("closes fixed ones on a re-run, and lets a person close the rest with a note", async () => {
    await start();
    const { owner, key } = await merchant();
    const other = await merchant("Other Shop");
    const analyst = await addMember(t.app, owner, "analyst");
    const a = await paid(key, 50_000);
    const b = await paid(key, 30_000);
    const pa = rzp.payments.get(a.paymentId);
    const pb = rzp.payments.get(b.paymentId);
    if (pa) pa.amount = 1;
    if (pb) pb.amount = 2;
    await reconcile();
    const [first, second] = (await mismatches({ status: "open" })).sort((x, y) =>
      x.paymentIntentId === a.id ? -1 : y.paymentIntentId === a.id ? 1 : 0,
    );

    // Razorpay corrected the first; the second is explained by a person
    if (pa) pa.amount = 50_000;
    const noNote = await request(t.app)
      .post(`/v1/reconciliation/mismatches/${second?._id}/resolve`)
      .set(bearer(owner.accessToken))
      .send({});
    const byAnalyst = await request(t.app)
      .post(`/v1/reconciliation/mismatches/${second?._id}/resolve`)
      .set(bearer(analyst.accessToken))
      .send({ note: "Looked fine" });
    const foreign = await request(t.app)
      .post(`/v1/reconciliation/mismatches/${second?._id}/resolve`)
      .set(bearer(other.owner.accessToken))
      .send({ note: "Not mine" });
    const resolved = await request(t.app)
      .post(`/v1/reconciliation/mismatches/${second?._id}/resolve`)
      .set(bearer(owner.accessToken))
      .send({ note: "Partial capture agreed with the customer; ticket FIN-42" });
    const twice = await request(t.app)
      .post(`/v1/reconciliation/mismatches/${second?._id}/resolve`)
      .set(bearer(owner.accessToken))
      .send({ note: "again" });
    const rerun = await reconcile();

    expect(noNote.status).toBe(422);
    expect(byAnalyst.status).toBe(403);
    expect(foreign.status).toBe(404);
    expect(resolved.body).toMatchObject({ status: "resolved", resolution: "manual" });
    expect(twice.status).toBe(409);
    expect(rerun.counts?.resolvedSinceLastRun).toBe(1);
    const after = await t.app.locals.models.ReconMismatch.find().lean<ReconMismatch[]>();
    expect(after.find((m) => m._id === first?._id)).toMatchObject({
      status: "resolved",
      resolution: "auto",
      note: "No longer found by a later run",
    });
    // Still mismatched, but a person closed it: not reopened
    expect(after.find((m) => m._id === second?._id)).toMatchObject({ resolution: "manual" });
  });

  it("exports a run as CSV, safe to open in a spreadsheet", async () => {
    await start();
    const { owner, key } = await merchant();
    const a = await paid(key, 50_000);
    const pa = rzp.payments.get(a.paymentId);
    if (pa) pa.amount = 40_000;
    rzp.settle(DAY, { payments: [a.paymentId] });
    const run = await reconcile();
    await t.app.locals.models.ReconMismatch.updateOne(
      { type: "amount_mismatch" },
      { $set: { message: '=HYPERLINK("https://evil.example")' } },
    );

    const res = await request(t.app)
      .get(`/v1/reconciliation/runs/${run._id}/report.csv`)
      .set(bearer(owner.accessToken));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["content-disposition"]).toContain(`reconciliation-test-${DAY}.csv`);
    const rows = res.text.trim().split("\r\n");
    expect(rows[0]).toBe(
      '"section","type","id","payment_intent","status","expected","actual","message"',
    );
    expect(rows.some((r) => r.startsWith('"settlement"'))).toBe(true);
    const mismatch = rows.find((r) => r.startsWith('"mismatch","amount_mismatch"'));
    expect(mismatch).toContain(`"'=HYPERLINK(""https://evil.example"")"`);
  });
});

describe("running it", () => {
  it("one run per day at a time", async () => {
    await start();
    const { key } = await merchant();
    await paid(key, 10_000);

    const results = await Promise.allSettled([reconcile(), reconcile()]);

    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const failure = results.find((r) => r.status === "rejected");
    expect((failure as PromiseRejectedResult).reason).toMatchObject({ code: "already_running" });
  });

  it("records a failed run", async () => {
    await start();
    rzp.outage = 503;

    await expect(reconcile()).rejects.toThrow();
    const run = await t.app.locals.models.ReconciliationRun.findOne({ date: DAY }).lean();
    expect(run).toMatchObject({ status: "failed", error: "Down" });
  });

  it("works out the day, in India time", () => {
    expect(previousIstDay(new Date("2026-11-27T20:00:00Z"))).toBe("2026-11-27"); // 01:30 IST on the 28th
    expect(previousIstDay(new Date("2026-11-27T10:00:00Z"))).toBe("2026-11-26");
    expect(dayWindow("2026-11-27")).toMatchObject({
      from: Date.UTC(2026, 10, 26, 18, 30) / 1000,
      to: Date.UTC(2026, 10, 27, 18, 30) / 1000,
    });
    expect(() => dayWindow("2026-02-30")).toThrow(/doesn't exist/);
    expect(() => dayWindow("27-11-2026")).toThrow(/YYYY-MM-DD/);
  });

  it("schedules one nightly job however many instances start", async () => {
    await start();
    const config = {
      ...testConfig(),
      reconciliation: { cron: "0 6 * * *", timezone: "Asia/Kolkata", overdueDays: 3 },
    };
    const stopA = await startReconciliationScheduler(deps(), config);
    const stopB = await startReconciliationScheduler(deps(), config);
    const queue = new Queue(RECON_QUEUE, {
      connection: new Redis(config.redisUrl, { maxRetriesPerRequest: null }),
      prefix: "payguard",
    });
    try {
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers).toHaveLength(1);
      expect(schedulers[0]).toMatchObject({ pattern: "0 6 * * *", tz: "Asia/Kolkata" });
    } finally {
      await queue.obliterate({ force: true });
      await queue.close();
      await stopA();
      await stopB();
    }
    // Without keys for a mode, it's skipped
    expect(await reconcileDay(deps(), config, { date: DAY, modes: ["live"] })).toEqual([]);
  });
});
