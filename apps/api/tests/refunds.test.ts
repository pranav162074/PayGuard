import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { signPayment, signWebhook } from "../src/gateway/razorpay.js";
import { createLogger } from "../src/logger.js";
import { createGateways } from "../src/payments/checkout.js";
import type { Refund } from "../src/payments/models.js";
import { reconcileRefunds, type RefundDeps } from "../src/payments/refunds.js";
import { FakeRazorpay } from "./fakeRazorpay.js";
import { addMember, bearer, signup, startTestApp, type TestApp } from "./helpers.js";

const KEYS = { keyId: "rzp_test_Fake1234", keySecret: "fake_key_secret_123" };
const WEBHOOK_SECRET = "fake_webhook_secret_123";

let t: TestApp;
let rzp: FakeRazorpay;
let started = false;

afterEach(async () => {
  if (started) await t.close();
  started = false;
});

async function start(): Promise<void> {
  rzp = new FakeRazorpay(KEYS.keyId, KEYS.keySecret);
  t = await startTestApp({
    razorpayFetch: rzp.fetch,
    config: {
      razorpay: {
        test: KEYS,
        webhookSecret: WEBHOOK_SECRET,
        live: null,
        apiUrl: "https://api.razorpay.test/v1",
      },
      checkoutUrl: "https://pay.example.com",
    },
  });
  started = true;
}

async function merchant() {
  const owner = await signup(t.app, { businessName: "Chai Point" });
  const created = await request(t.app)
    .post("/v1/api-keys")
    .set(bearer(owner.accessToken))
    .send({ name: "server", mode: "test" });
  return { owner, key: created.body.key as string };
}

async function newIntent(key: string, amount = 50_000): Promise<string> {
  const res = await request(t.app).post("/v1/payment_intents").set(bearer(key)).send({ amount });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

/** A payment completed with test_actions: never touched Razorpay. */
async function paidWithoutGateway(key: string, amount = 50_000): Promise<string> {
  const id = await newIntent(key, amount);
  const res = await request(t.app)
    .post(`/v1/payment_intents/${id}/test_actions`)
    .set(bearer(key))
    .send({ outcome: "succeed" });
  expect(res.status).toBe(200);
  return id;
}

/** A payment the customer made on Razorpay's checkout. */
async function paidThroughRazorpay(key: string, amount = 50_000) {
  const id = await newIntent(key, amount);
  const intent = await request(t.app).get(`/v1/payment_intents/${id}`).set(bearer(key));
  const opened = await request(t.app)
    .get(`/v1/checkout/${id}`)
    .query({ client_secret: intent.body.client_secret });
  const orderId = opened.body.razorpay.order_id as string;
  const payment = rzp.pay(orderId);
  const confirmed = await request(t.app)
    .post(`/v1/checkout/${id}/confirm`)
    .send({
      client_secret: intent.body.client_secret,
      razorpay_order_id: orderId,
      razorpay_payment_id: payment.id,
      razorpay_signature: signPayment(KEYS.keySecret, orderId, payment.id),
    });
  expect(confirmed.body.status).toBe("succeeded");
  return { id, paymentId: payment.id };
}

function refund(key: string, id: string, body: object = {}, idempotencyKey?: string) {
  const req = request(t.app).post(`/v1/payment_intents/${id}/refunds`).set(bearer(key));
  return (idempotencyKey ? req.set("Idempotency-Key", idempotencyKey) : req).send(body);
}

async function balances(token: string): Promise<Record<string, number>> {
  const res = await request(t.app).get("/v1/ledger/accounts").set(bearer(token));
  return Object.fromEntries(
    (res.body.accounts as { code: string; balance: number }[]).map((a) => [a.code, a.balance]),
  );
}

async function verify(token: string) {
  return (await request(t.app).get("/v1/ledger/verify").set(bearer(token))).body as {
    balanced: boolean;
  };
}

function refundWebhook(type: string, entity: object) {
  const raw = JSON.stringify({
    entity: "event",
    event: type,
    contains: ["refund", "payment"],
    payload: { refund: { entity } },
  });
  return request(t.app)
    .post("/v1/webhooks/razorpay")
    .set("Content-Type", "application/json")
    .set("X-Razorpay-Signature", signWebhook(WEBHOOK_SECRET, raw))
    .set("X-Razorpay-Event-Id", `evt_${Math.random().toString(36).slice(2)}`)
    .send(raw);
}

function refundDeps(): RefundDeps {
  return {
    mongo: t.mongo,
    models: t.app.locals.models,
    feeBasisPoints: t.config.platformFeeBps,
    gateways: createGateways(t.config, rzp.fetch),
    logger: createLogger("silent"),
  };
}

async function eventsOf(intentId: string): Promise<string[]> {
  const events = await t.app.locals.models.PaymentEvent.find({ paymentIntentId: intentId })
    .sort({ _id: 1 })
    .lean();
  return events.map((e) => e.type);
}

const LATER = () => new Date(Date.now() + 10 * 60_000);

describe("refunds without a gateway (test_actions payments)", () => {
  it("a full refund gives the money and the whole fee back", async () => {
    await start();
    const { owner, key } = await merchant();
    const id = await paidWithoutGateway(key);

    const res = await refund(key, id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: "refund",
      payment_intent: id,
      amount: 50_000,
      fee_returned: 1_000,
      status: "succeeded",
      reason: "requested_by_customer",
      gateway: { provider: "none", refund_id: null },
    });
    expect(res.body.id).toMatch(/^re_/);
    expect(await balances(owner.accessToken)).toMatchObject({
      gateway_receivable: 0,
      merchant_payable: 0,
      fee_revenue: 0,
    });
    const intent = await request(t.app).get(`/v1/payment_intents/${id}`).set(bearer(key));
    expect(intent.body).toMatchObject({ amount_refunded: 50_000, refunded: true });
    expect(await eventsOf(id)).toEqual(
      expect.arrayContaining(["refund.created", "refund.succeeded", "payment_intent.refunded"]),
    );
    expect((await verify(owner.accessToken)).balanced).toBe(true);
  });

  it("partial refunds return the fee proportionally, and exactly in total", async () => {
    await start();
    const { owner, key } = await merchant();
    // 2% of 333.33 = 666.66 paise → fee 667 (rounded); thirds don't divide it evenly
    const id = await paidWithoutGateway(key, 33_333);
    const fee = (await request(t.app).get(`/v1/payment_intents/${id}`).set(bearer(key))).body
      .fee as number;

    const first = await refund(key, id, { amount: 11_111 });
    const second = await refund(key, id, { amount: 11_111, reason: "duplicate", note: "oops" });
    const rest = await refund(key, id);

    expect(first.body.fee_returned).toBe(Math.floor((fee * 11_111) / 33_333));
    expect(second.body).toMatchObject({ reason: "duplicate", note: "oops" });
    expect(rest.body.amount).toBe(11_111);
    const returned = [first, second, rest].map((r) => r.body.fee_returned as number);
    expect(returned.reduce((a, b) => a + b, 0)).toBe(fee);
    expect(await balances(owner.accessToken)).toMatchObject({
      gateway_receivable: 0,
      merchant_payable: 0,
      fee_revenue: 0,
    });
    const again = await refund(key, id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("already_refunded");
  });

  it("never refunds more than was paid, even when refunds race", async () => {
    await start();
    const { owner, key } = await merchant();
    const id = await paidWithoutGateway(key, 50_000);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => refund(key, id, { amount: 10_000 })),
    );

    const ok = results.filter((r) => r.status === 201);
    expect(ok).toHaveLength(5);
    for (const r of results.filter((x) => x.status !== 201)) {
      // Lost the race for the reservation, or the transaction's write conflict
      expect([409, 422]).toContain(r.status);
    }
    const intent = await t.app.locals.models.PaymentIntent.findById(id).lean();
    expect(intent?.amountRefunded).toBe(50_000);
    expect(await t.app.locals.models.Refund.countDocuments({ paymentIntentId: id })).toBe(5);
    expect((await balances(owner.accessToken)).merchant_payable).toBe(0);
    expect((await verify(owner.accessToken)).balanced).toBe(true);
  });

  it("refuses too much, and payments that didn't succeed", async () => {
    await start();
    const { key } = await merchant();
    const id = await paidWithoutGateway(key, 50_000);
    const unpaid = await newIntent(key);

    const tooMuch = await refund(key, id, { amount: 50_001 });
    const tooSmall = await refund(key, id, { amount: 99 });
    const notPaid = await refund(key, unpaid);
    const missing = await refund(key, "pi_doesnotexist");

    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error).toMatchObject({
      code: "amount_too_large",
      details: { refundable: 50_000 },
    });
    expect(tooSmall.status).toBe(422);
    expect(tooSmall.body.error.code).toBe("validation_error");
    expect(notPaid.status).toBe(409);
    expect(notPaid.body.error.code).toBe("invalid_state");
    expect(missing.status).toBe(404);
  });

  it("an Idempotency-Key makes a retried refund return the same one", async () => {
    await start();
    const { key } = await merchant();
    const id = await paidWithoutGateway(key);

    const a = await refund(key, id, { amount: 10_000 }, "refund-1");
    const b = await refund(key, id, { amount: 10_000 }, "refund-1");

    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await t.app.locals.models.Refund.countDocuments({ paymentIntentId: id })).toBe(1);
  });

  it("lists refunds per payment and per merchant; analysts read, can't refund", async () => {
    await start();
    const { owner, key } = await merchant();
    const other = await merchant();
    const id = await paidWithoutGateway(key);
    const created = (await refund(key, id, { amount: 1_000 })).body;
    await refund(key, id, { amount: 2_000 });
    const analyst = await addMember(t.app, owner, "analyst");

    const perPayment = await request(t.app)
      .get(`/v1/payment_intents/${id}/refunds`)
      .set(bearer(key));
    const all = await request(t.app).get("/v1/refunds").set(bearer(analyst.accessToken));
    const one = await request(t.app).get(`/v1/refunds/${created.id}`).set(bearer(key));
    const foreign = await request(t.app).get(`/v1/refunds/${created.id}`).set(bearer(other.key));
    const foreignList = await request(t.app).get("/v1/refunds").set(bearer(other.key));
    const denied = await request(t.app)
      .post(`/v1/payment_intents/${id}/refunds`)
      .set(bearer(analyst.accessToken))
      .send({ amount: 1_000 });

    expect(perPayment.body.data).toHaveLength(2);
    expect(all.status).toBe(200);
    expect(all.body.data).toHaveLength(2);
    expect(one.body).toMatchObject({ id: created.id, amount: 1_000 });
    expect(foreign.status).toBe(404);
    expect(foreignList.body.data).toEqual([]);
    expect(denied.status).toBe(403);
  });
});

describe("refunds through Razorpay", () => {
  it("test mode: Razorpay processes it at once", async () => {
    await start();
    const { owner, key } = await merchant();
    const { id, paymentId } = await paidThroughRazorpay(key);

    const res = await refund(key, id, { amount: 20_000 });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("succeeded");
    const [sent] = rzp.refundsOf(paymentId);
    expect(res.body.gateway).toEqual({ provider: "razorpay", refund_id: sent?.id });
    expect(sent).toMatchObject({ amount: 20_000, notes: { payguard_refund: res.body.id } });
    expect((await balances(owner.accessToken)).merchant_payable).toBe(49_000 - 19_600);
  });

  it("a pending refund finishes when Razorpay's webhook arrives", async () => {
    await start();
    const { key } = await merchant();
    const { id, paymentId } = await paidThroughRazorpay(key);
    rzp.refundOutcome = "pending";

    const res = await refund(key, id);
    expect(res.body.status).toBe("pending");
    const gatewayRefund = rzp.refundsOf(paymentId)[0];
    expect(res.body.gateway.refund_id).toBe(gatewayRefund?.id);

    rzp.settleRefund(gatewayRefund?.id as string, "processed");
    const hook = await refundWebhook("refund.processed", { ...gatewayRefund });

    expect(hook.status).toBe(200);
    const after = await request(t.app).get(`/v1/refunds/${res.body.id}`).set(bearer(key));
    expect(after.body.status).toBe("succeeded");
    expect(await eventsOf(id)).toContain("payment_intent.refunded");
  });

  it("a refund the bank fails gives the merchant their money back", async () => {
    await start();
    const { owner, key } = await merchant();
    const { id, paymentId } = await paidThroughRazorpay(key);
    rzp.refundOutcome = "pending";
    const before = await balances(owner.accessToken);

    const res = await refund(key, id, { amount: 30_000 });
    const gatewayRefund = rzp.refundsOf(paymentId)[0];
    rzp.settleRefund(gatewayRefund?.id as string, "failed");
    await refundWebhook("refund.failed", { ...gatewayRefund });

    const after = await request(t.app).get(`/v1/refunds/${res.body.id}`).set(bearer(key));
    expect(after.body).toMatchObject({ status: "failed" });
    expect(after.body.reversal_entry_id).toEqual(expect.any(String));
    expect(await balances(owner.accessToken)).toEqual(before);
    const intent = await request(t.app).get(`/v1/payment_intents/${id}`).set(bearer(key));
    expect(intent.body.amount_refunded).toBe(0);
    // The money is free again: the whole payment can still be refunded
    rzp.refundOutcome = "processed";
    expect((await refund(key, id)).body).toMatchObject({ amount: 50_000, status: "succeeded" });
    expect((await verify(owner.accessToken)).balanced).toBe(true);
  });

  it("Razorpay refusing the refund fails it and restores the balance", async () => {
    await start();
    const { owner, key } = await merchant();
    const { id } = await paidThroughRazorpay(key);
    rzp.refundOutcome = "rejected";
    const before = await balances(owner.accessToken);

    const res = await refund(key, id);

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "failed" });
    expect(res.body.failure_reason).toMatch(/can't be processed/);
    expect(await balances(owner.accessToken)).toEqual(before);
    expect(await eventsOf(id)).toEqual(expect.arrayContaining(["refund.failed"]));
  });

  it("an outage leaves it pending, and the reconciler sends it once", async () => {
    await start();
    const { key } = await merchant();
    const { id, paymentId } = await paidThroughRazorpay(key);
    rzp.outage = 503;

    const res = await refund(key, id, { amount: 5_000 });
    expect(res.body).toMatchObject({ status: "pending", gateway: { refund_id: null } });

    rzp.outage = null;
    const pass = await reconcileRefunds(refundDeps(), { afterSeconds: 60, now: LATER() });

    expect(pass).toMatchObject({ checked: 1, changed: 1, errors: 0 });
    expect(rzp.refundsOf(paymentId)).toHaveLength(1);
    const after = await request(t.app).get(`/v1/refunds/${res.body.id}`).set(bearer(key));
    expect(after.body.status).toBe("succeeded");
  });

  it("a lost response is found by our id at Razorpay: never refunded twice", async () => {
    await start();
    const { key } = await merchant();
    const { id, paymentId } = await paidThroughRazorpay(key);
    // Razorpay makes the refund, but its answer never reaches us
    rzp.loseNextRefundResponse = true;

    const res = await refund(key, id, { amount: 5_000 });
    expect(res.body.status).toBe("pending");
    expect(rzp.refundsOf(paymentId)).toHaveLength(1);

    await reconcileRefunds(refundDeps(), { afterSeconds: 60, now: LATER() });
    await reconcileRefunds(refundDeps(), { afterSeconds: 60, now: LATER() });

    expect(rzp.refundsOf(paymentId)).toHaveLength(1);
    const refundDoc = await t.app.locals.models.Refund.findById(res.body.id).lean<Refund>();
    expect(refundDoc?.status).toBe("succeeded");
    expect(refundDoc?.gateway?.refundId).toBe(rzp.refundsOf(paymentId)[0]?.id);
  });

  it("the webhook also finds a refund by the id in its notes", async () => {
    await start();
    const { key } = await merchant();
    const { id, paymentId } = await paidThroughRazorpay(key);
    rzp.refundOutcome = "pending";
    rzp.loseNextRefundResponse = true;
    const res = await refund(key, id);
    const gatewayRefund = rzp.refundsOf(paymentId)[0];
    rzp.settleRefund(gatewayRefund?.id as string, "processed");

    const hook = await refundWebhook("refund.processed", { ...gatewayRefund });
    const unknown = await refundWebhook("refund.processed", { id: "rfnd_notours", notes: [] });

    expect(hook.status).toBe(200);
    expect(unknown.status).toBe(200);
    const after = await request(t.app).get(`/v1/refunds/${res.body.id}`).set(bearer(key));
    expect(after.body).toMatchObject({
      status: "succeeded",
      gateway: { refund_id: gatewayRefund?.id },
    });
    expect(rzp.refundsOf(paymentId)).toHaveLength(1);
  });
});
