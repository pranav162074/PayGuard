import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";
import { signPayment } from "../src/gateway/razorpay.js";
import type { PaymentIntent } from "../src/payments/models.js";
import { FakeRazorpay } from "./fakeRazorpay.js";
import { bearer, memoryLogger, signup, startTestApp, type TestApp } from "./helpers.js";

const KEYS = { keyId: "rzp_test_Fake1234", keySecret: "fake_key_secret_123" };

let t: TestApp;
let rzp: FakeRazorpay;
let started = false;
let logLines: () => Record<string, unknown>[] = () => [];

afterEach(async () => {
  if (started) await t.close();
  started = false;
});

async function start(options: { live?: boolean } = {}): Promise<void> {
  rzp = new FakeRazorpay(KEYS.keyId, KEYS.keySecret);
  const memory = memoryLogger();
  logLines = memory.lines;
  t = await startTestApp({
    logger: memory.logger,
    razorpayFetch: rzp.fetch,
    config: {
      razorpay: {
        test: KEYS,
        live: options.live ? { keyId: "rzp_live_Fake1234", keySecret: "live_secret_123" } : null,
        apiUrl: "https://api.razorpay.test/v1",
      },
      checkoutUrl: "https://pay.example.com",
    },
  });
  started = true;
}

async function keyFor(mode: "test" | "live" = "test"): Promise<string> {
  const owner = await signup(t.app, { businessName: "Chai Point" });
  const res = await request(t.app)
    .post("/v1/api-keys")
    .set(bearer(owner.accessToken))
    .send({ name: "server", mode });
  return res.body.key as string;
}

async function newIntent(key: string, body: object = { amount: 50_000 }) {
  const res = await request(t.app).post("/v1/payment_intents").set(bearer(key)).send(body);
  expect(res.status).toBe(201);
  return res.body as { id: string; client_secret: string; checkout_url: string; status: string };
}

function openCheckout(id: string, secret: string) {
  return request(t.app).get(`/v1/checkout/${id}`).query({ client_secret: secret });
}

function confirm(
  id: string,
  secret: string,
  orderId: string,
  paymentId: string,
  signature?: string,
) {
  return request(t.app)
    .post(`/v1/checkout/${id}/confirm`)
    .send({
      client_secret: secret,
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature ?? signPayment(KEYS.keySecret, orderId, paymentId),
    });
}

function sync(key: string, id: string) {
  return request(t.app).post(`/v1/payment_intents/${id}/sync`).set(bearer(key));
}

async function intentDoc(id: string): Promise<PaymentIntent> {
  return (await t.app.locals.models.PaymentIntent.findById(
    id,
  ).lean<PaymentIntent>()) as PaymentIntent;
}

async function captureEntries(id: string): Promise<number> {
  return t.app.locals.models.LedgerEntry.countDocuments({ "reference.id": id });
}

/** An intent whose checkout has been opened, so it has a Razorpay order. */
async function openedIntent(mode: "test" | "live" = "test") {
  const key = await keyFor(mode);
  const intent = await newIntent(key);
  const opened = await openCheckout(intent.id, intent.client_secret);
  expect(opened.status).toBe(200);
  return { key, intent, orderId: opened.body.razorpay.order_id as string };
}

describe("checkout links", () => {
  it("gives the merchant a client secret and a hosted checkout url", async () => {
    await start();
    const intent = await newIntent(await keyFor());

    expect(intent.client_secret).toMatch(/^cs_[0-9a-f]{24}$/);
    expect(intent.checkout_url).toBe(
      `https://pay.example.com/pay/${intent.id}?client_secret=${intent.client_secret}`,
    );
  });

  it("opens the checkout with a Razorpay order created once, and only for the right secret", async () => {
    await start();
    const intent = await newIntent(await keyFor(), {
      amount: 25_000,
      description: "Masala chai x5",
    });

    expect((await openCheckout(intent.id, "cs_wrong")).status).toBe(404);
    expect((await openCheckout("pi_doesnotexist", intent.client_secret)).status).toBe(404);
    expect(rzp.orders.size).toBe(0);

    const first = await openCheckout(intent.id, intent.client_secret);
    const second = await openCheckout(intent.id, intent.client_secret);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      id: intent.id,
      status: "requires_payment",
      amount: 25_000,
      currency: "INR",
      description: "Masala chai x5",
      mode: "test",
      merchant: { name: "Chai Point" },
      razorpay: { key_id: KEYS.keyId },
    });
    expect(first.body).not.toHaveProperty("client_secret");
    expect(second.body.razorpay.order_id).toBe(first.body.razorpay.order_id);
    expect(rzp.orders.size).toBe(1);
    const order = rzp.orders.get(first.body.razorpay.order_id as string);
    expect(order).toMatchObject({ amount: 25_000, currency: "INR", receipt: intent.id });
    expect(order?.notes.payment_intent).toBe(intent.id);
  });

  it("keeps one order when two checkouts open at the same moment", async () => {
    await start();
    const intent = await newIntent(await keyFor());

    const results = await Promise.all(
      Array.from({ length: 5 }, () => openCheckout(intent.id, intent.client_secret)),
    );
    const orderIds = new Set(results.map((r) => r.body.razorpay.order_id as string));
    expect(orderIds.size).toBe(1);
    expect((await intentDoc(intent.id)).gateway?.orderId).toBe([...orderIds][0]);
  });

  it("refuses to take live payments when no live keys are configured", async () => {
    await start();
    const intent = await newIntent(await keyFor("live"));

    const res = await openCheckout(intent.id, intent.client_secret);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("gateway_not_configured");
  });

  it("reports Razorpay failures as 502 without saving a half-made order", async () => {
    await start();
    const intent = await newIntent(await keyFor());
    rzp.outage = 500;

    const res = await openCheckout(intent.id, intent.client_secret);
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe("gateway_error");
    expect((await intentDoc(intent.id)).gateway?.orderId ?? null).toBeNull();
  });
});

describe("confirming a payment", () => {
  it("verifies the signature, checks with Razorpay and captures into the ledger", async () => {
    await start();
    const { key, intent, orderId } = await openedIntent();
    const payment = rzp.pay(orderId);

    const res = await confirm(intent.id, intent.client_secret, orderId, payment.id);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("succeeded");
    const doc = await intentDoc(intent.id);
    expect(doc.gateway).toMatchObject({
      provider: "razorpay",
      orderId,
      paymentId: payment.id,
      method: "upi",
    });
    expect(doc.fee).toBe(1000);
    expect(await captureEntries(intent.id)).toBe(1);

    const merchantView = await request(t.app)
      .get(`/v1/payment_intents/${intent.id}`)
      .set(bearer(key));
    expect(merchantView.body).toMatchObject({
      status: "succeeded",
      checkout_url: null,
      gateway: { provider: "razorpay", order_id: orderId, payment_id: payment.id, method: "upi" },
    });
    const events = await request(t.app)
      .get(`/v1/payment_intents/${intent.id}/events`)
      .set(bearer(key));
    expect(events.body.data.map((e: { type: string }) => e.type)).toEqual([
      "payment_intent.created",
      "payment_intent.processing",
      "payment_intent.succeeded",
    ]);
  });

  it("rejects a forged signature and a payment for another order", async () => {
    await start();
    const { intent, orderId } = await openedIntent();
    const payment = rzp.pay(orderId);

    const forged = await confirm(
      intent.id,
      intent.client_secret,
      orderId,
      payment.id,
      "0".repeat(64),
    );
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("invalid_signature");

    const other = await openedIntent();
    const crossed = await confirm(intent.id, intent.client_secret, other.orderId, payment.id);
    expect(crossed.status).toBe(422);
    expect(crossed.body.error.code).toBe("order_mismatch");

    expect((await intentDoc(intent.id)).status).toBe("requires_payment");
    expect(await captureEntries(intent.id)).toBe(0);
  });

  it("captures authorized payments itself when the account doesn't auto-capture", async () => {
    await start();
    const { intent, orderId } = await openedIntent();
    rzp.autoCapture = false;
    const payment = rzp.pay(orderId);
    expect(payment.status).toBe("authorized");

    const res = await confirm(intent.id, intent.client_secret, orderId, payment.id);

    expect(res.body.status).toBe("succeeded");
    expect(rzp.payments.get(payment.id)?.status).toBe("captured");
    expect(rzp.calls).toContain(`POST /payments/${payment.id}/capture`);
  });

  it("parks the payment as processing when Razorpay is unreachable, and a later sync finishes it", async () => {
    await start();
    const { key, intent, orderId } = await openedIntent();
    const payment = rzp.pay(orderId);
    rzp.outage = 0;

    const res = await confirm(intent.id, intent.client_secret, orderId, payment.id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("processing");
    expect(await captureEntries(intent.id)).toBe(0);

    // Still down: the merchant's sync says so instead of guessing
    const failedSync = await sync(key, intent.id);
    expect(failedSync.status).toBe(502);
    expect(failedSync.body.error.code).toBe("gateway_error");

    rzp.outage = null;
    const synced = await sync(key, intent.id);
    expect(synced.status).toBe(200);
    expect(synced.body.status).toBe("succeeded");
    expect(await captureEntries(intent.id)).toBe(1);
  });

  it("marks the intent failed when every attempt failed, and still accepts a later success", async () => {
    await start();
    const { intent, orderId } = await openedIntent();
    const declined = rzp.pay(orderId, "failure");

    const res = await confirm(intent.id, intent.client_secret, orderId, declined.id);
    expect(res.body.status).toBe("failed");
    expect(res.body.failure_reason).toBe("Payment declined by bank");

    // The customer tries again on the same order and it goes through
    const reopened = await openCheckout(intent.id, intent.client_secret);
    expect(reopened.body.razorpay.order_id).toBe(orderId);
    const retry = rzp.pay(orderId);
    const ok = await confirm(intent.id, intent.client_secret, orderId, retry.id);
    expect(ok.body.status).toBe("succeeded");
    expect((await intentDoc(intent.id)).gateway?.paymentId).toBe(retry.id);
  });

  it("never marks a payment paid when Razorpay's amount doesn't match", async () => {
    await start();
    const { intent, orderId } = await openedIntent();
    const payment = rzp.pay(orderId, "success", { amount: 100 });

    const res = await confirm(intent.id, intent.client_secret, orderId, payment.id);

    expect(res.body.status).toBe("processing");
    expect(await captureEntries(intent.id)).toBe(0);
    expect(logLines().some((l) => String(l.msg).includes("doesn't match"))).toBe(true);
  });

  it("doesn't resurrect a canceled intent, and flags the payment for a refund", async () => {
    await start();
    const { key, intent, orderId } = await openedIntent();
    await request(t.app)
      .post(`/v1/payment_intents/${intent.id}/cancel`)
      .set(bearer(key))
      .expect(200);
    rzp.pay(orderId); // the customer still had the checkout open, and paid

    const synced = await sync(key, intent.id);

    expect(synced.body.status).toBe("canceled");
    expect(await captureEntries(intent.id)).toBe(0);
    expect(logLines().some((l) => String(l.msg).includes("needs a refund"))).toBe(true);
  });

  it("posts exactly one capture when the browser confirms and the merchant syncs at once", async () => {
    await start();
    const { key, intent, orderId } = await openedIntent();
    const payment = rzp.pay(orderId);

    const results = await Promise.all([
      confirm(intent.id, intent.client_secret, orderId, payment.id),
      confirm(intent.id, intent.client_secret, orderId, payment.id),
      sync(key, intent.id),
      sync(key, intent.id),
    ]);

    for (const res of results) expect(res.status).toBe(200);
    expect((await intentDoc(intent.id)).status).toBe("succeeded");
    expect(await captureEntries(intent.id)).toBe(1);
    const verify = await request(t.app).get("/v1/ledger/verify").set(bearer(key));
    expect(verify.body).toMatchObject({ balanced: true, mismatches: [] });
  });
});

describe("Razorpay configuration", () => {
  it("needs key id and secret together, each with its mode's prefix", () => {
    expect(() => loadConfig({ RAZORPAY_TEST_KEY_ID: "rzp_test_abc" })).toThrow(
      /must be set together/,
    );
    expect(() =>
      loadConfig({
        RAZORPAY_TEST_KEY_ID: "rzp_live_abc",
        RAZORPAY_TEST_KEY_SECRET: "x".repeat(10),
      }),
    ).toThrow(ConfigError);

    const config = loadConfig({
      RAZORPAY_TEST_KEY_ID: "rzp_test_abc",
      RAZORPAY_TEST_KEY_SECRET: "secret_value",
      CHECKOUT_URL: "https://pay.example.com/",
    });
    expect(config.razorpay.test).toEqual({ keyId: "rzp_test_abc", keySecret: "secret_value" });
    expect(config.razorpay.live).toBeNull();
    expect(config.checkoutUrl).toBe("https://pay.example.com");
  });
});
