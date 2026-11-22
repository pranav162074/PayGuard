import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { canTransition, PAYMENT_STATUSES, TRANSITIONS } from "../src/payments/stateMachine.js";
import { addMember, bearer, signup, startTestApp, type TestApp } from "./helpers.js";

let t: TestApp;
let started = false;

afterEach(async () => {
  if (started) await t.close();
  started = false;
});

async function start(): Promise<void> {
  t = await startTestApp();
  started = true;
}

async function merchantWithKey(mode: "test" | "live" = "test") {
  const owner = await signup(t.app);
  const created = await request(t.app)
    .post("/v1/api-keys")
    .set(bearer(owner.accessToken))
    .send({ name: "server", mode });
  return { owner, key: created.body.key as string };
}

function create(key: string, body: object = { amount: 50_000 }, idempotencyKey?: string) {
  const req = request(t.app).post("/v1/payment_intents").set(bearer(key));
  return (idempotencyKey ? req.set("Idempotency-Key", idempotencyKey) : req).send(body);
}

function testAction(key: string, id: string, outcome: "succeed" | "fail") {
  return request(t.app)
    .post(`/v1/payment_intents/${id}/test_actions`)
    .set(bearer(key))
    .send({ outcome });
}

describe("state machine", () => {
  it("terminal states go nowhere, and nothing returns to requires_payment", () => {
    expect(TRANSITIONS.succeeded).toEqual([]);
    expect(TRANSITIONS.canceled).toEqual([]);
    for (const from of PAYMENT_STATUSES)
      expect(canTransition(from, "requires_payment")).toBe(false);
    expect(canTransition("processing", "canceled")).toBe(false);
  });
});

describe("creating payment intents", () => {
  it("creates one, in the key's mode, and records the event", async () => {
    await start();
    const { key } = await merchantWithKey();

    const res = await create(key, {
      amount: 50_000,
      description: "Order #1001",
      receipt: "order_1001",
      customer: { email: "buyer@example.com" },
      metadata: { cart: "42" },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      object: "payment_intent",
      amount: 50_000,
      currency: "INR",
      status: "requires_payment",
      mode: "test",
      receipt: "order_1001",
      metadata: { cart: "42" },
      fee: null,
    });
    expect(res.body.id).toMatch(/^pi_[0-9a-f]{24}$/);
    const events = await request(t.app)
      .get(`/v1/payment_intents/${res.body.id}/events`)
      .set(bearer(key));
    expect(events.body.data.map((e: { type: string }) => e.type)).toEqual([
      "payment_intent.created",
    ]);
  });

  it.each([
    [{ amount: 99 }, "amount"],
    [{ amount: 100.5 }, "amount"],
    [{ amount: "500" }, "amount"],
    [{ amount: 500, currency: "USD" }, "currency"],
    [{ amount: 500, customer: { email: "nope" } }, "customer.email"],
    [{ amount: 500, extra: true }, null],
  ])("rejects %j", async (body, field) => {
    await start();
    const { key } = await merchantWithKey();

    const res = await create(key, body);

    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d: { field: string | null }) => d.field)).toContain(field);
  });

  it("refuses a second intent for the same receipt", async () => {
    await start();
    const { key } = await merchantWithKey();
    await create(key, { amount: 500, receipt: "order_1" });

    const again = await create(key, { amount: 500, receipt: "order_1" });

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("duplicate_receipt");
  });
});

describe("Idempotency-Key", () => {
  it("replays the first response instead of creating a second payment", async () => {
    await start();
    const { key } = await merchantWithKey();

    const first = await create(key, { amount: 50_000 }, "order-1001-attempt");
    const retry = await create(key, { amount: 50_000 }, "order-1001-attempt");

    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(await t.app.locals.models.PaymentIntent.countDocuments()).toBe(1);
  });

  it("refuses the same key with a different request", async () => {
    await start();
    const { key } = await merchantWithKey();
    await create(key, { amount: 50_000 }, "k1");

    const res = await create(key, { amount: 60_000 }, "k1");

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("idempotency_key_reused");
  });

  it("lets only one of many simultaneous requests with one key through", async () => {
    await start();
    const { key } = await merchantWithKey();

    const results = await Promise.all(
      Array.from({ length: 8 }, () => create(key, { amount: 50_000 }, "burst")),
    );

    // Each either created it, replayed it, or was told to retry: never a second payment
    for (const res of results) expect([201, 409]).toContain(res.status);
    const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.body.id as string));
    expect(ids.size).toBe(1);
    expect(await t.app.locals.models.PaymentIntent.countDocuments()).toBe(1);
  });

  it("is scoped to the merchant: two merchants can use the same key", async () => {
    await start();
    const a = await merchantWithKey();
    const b = await merchantWithKey();

    const fromA = await create(a.key, { amount: 500 }, "shared");
    const fromB = await create(b.key, { amount: 500 }, "shared");

    expect(fromA.status).toBe(201);
    expect(fromB.status).toBe(201);
    expect(fromB.body.id).not.toBe(fromA.body.id);
  });

  it("replays errors too, so a retry of a refused request is refused the same way", async () => {
    await start();
    const { key } = await merchantWithKey();

    const first = await create(key, { amount: 5 }, "bad");
    const retry = await create(key, { amount: 5 }, "bad");

    expect(first.status).toBe(422);
    expect(retry.status).toBe(422);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
  });

  it("takes over a key whose first request crashed", async () => {
    await start();
    const { key } = await merchantWithKey();
    await create(key, { amount: 500 }, "crashed");
    // Make it look like the first request died half-way, long ago
    await t.app.locals.models.IdempotencyRecord.updateMany(
      {},
      { $set: { state: "in_progress", lockedUntil: new Date(Date.now() - 1000) } },
    );

    const retry = await create(key, { amount: 500 }, "crashed");

    expect(retry.status).toBe(201);
  });

  it("rejects malformed keys", async () => {
    await start();
    const { key } = await merchantWithKey();

    const res = await create(key, { amount: 500 }, "has spaces in it");

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("invalid_idempotency_key");
  });
});

describe("payment lifecycle", () => {
  it("a successful payment posts the capture to the ledger, atomically", async () => {
    await start();
    const { owner, key } = await merchantWithKey();
    const intent = (await create(key, { amount: 50_000 })).body;

    const res = await testAction(key, intent.id, "succeed");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "succeeded", fee: 1_000, net: 49_000 });
    const accounts = await request(t.app).get("/v1/ledger/accounts").set(bearer(owner.accessToken));
    const balance = (code: string) =>
      accounts.body.accounts.find((a: { code: string }) => a.code === code).balance as number;
    expect(balance("gateway_receivable")).toBe(50_000);
    expect(balance("merchant_payable")).toBe(49_000);
    expect(balance("fee_revenue")).toBe(1_000);
    const entry = await request(t.app)
      .get(`/v1/ledger/entries/${res.body.ledger_entry_id}`)
      .set(bearer(owner.accessToken));
    expect(entry.body.reference).toEqual({ type: "payment_intent", id: intent.id });
  });

  it("succeeding twice is refused and never posts twice", async () => {
    await start();
    const { key } = await merchantWithKey();
    const intent = (await create(key)).body;

    const results = await Promise.all([
      testAction(key, intent.id, "succeed"),
      testAction(key, intent.id, "succeed"),
      testAction(key, intent.id, "succeed"),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(await t.app.locals.models.LedgerEntry.countDocuments()).toBe(1);
  });

  it("a canceled payment can't succeed, and a succeeded one can't be canceled", async () => {
    await start();
    const { key } = await merchantWithKey();
    const canceled = (await create(key)).body;
    const paid = (await create(key)).body;
    await request(t.app).post(`/v1/payment_intents/${canceled.id}/cancel`).set(bearer(key));
    await testAction(key, paid.id, "succeed");

    const late = await testAction(key, canceled.id, "succeed");
    const cancelPaid = await request(t.app)
      .post(`/v1/payment_intents/${paid.id}/cancel`)
      .set(bearer(key));

    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("invalid_state");
    expect(cancelPaid.status).toBe(409);
  });

  it("a failed payment can be retried and then succeed", async () => {
    await start();
    const { key } = await merchantWithKey();
    const intent = (await create(key)).body;

    const failed = await testAction(key, intent.id, "fail");
    const succeeded = await testAction(key, intent.id, "succeed");
    const events = await request(t.app)
      .get(`/v1/payment_intents/${intent.id}/events`)
      .set(bearer(key));

    expect(failed.body).toMatchObject({ status: "failed", failure_reason: "card_declined" });
    expect(succeeded.body.status).toBe("succeeded");
    expect(events.body.data.map((e: { type: string }) => e.type)).toEqual([
      "payment_intent.created",
      "payment_intent.payment_failed",
      "payment_intent.succeeded",
    ]);
  });

  it("test actions don't work on live payments", async () => {
    await start();
    const { key } = await merchantWithKey("live");
    const intent = (await create(key)).body;

    const res = await testAction(key, intent.id, "succeed");

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("test_mode_only");
  });
});

describe("reading payment intents", () => {
  it("are scoped to the merchant and the mode", async () => {
    await start();
    const a = await merchantWithKey();
    const b = await merchantWithKey();
    const live = await request(t.app)
      .post("/v1/api-keys")
      .set(bearer(a.owner.accessToken))
      .send({ name: "live", mode: "live" });
    const intent = (await create(a.key)).body;

    const otherMerchant = await request(t.app)
      .get(`/v1/payment_intents/${intent.id}`)
      .set(bearer(b.key));
    const otherMode = await request(t.app)
      .get(`/v1/payment_intents/${intent.id}`)
      .set(bearer(live.body.key));
    const dashboard = await request(t.app)
      .get(`/v1/payment_intents/${intent.id}?mode=test`)
      .set(bearer(a.owner.accessToken));

    expect(otherMerchant.status).toBe(404);
    expect(otherMode.status).toBe(404);
    expect(dashboard.status).toBe(200);
  });

  it("list newest first, page with starting_after, and filter by status", async () => {
    await start();
    const { key } = await merchantWithKey();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1)
      ids.push((await create(key, { amount: 1_000 + i })).body.id as string);
    await testAction(key, ids[0] as string, "succeed");

    const page1 = await request(t.app).get("/v1/payment_intents?limit=3").set(bearer(key));
    const page2 = await request(t.app)
      .get(`/v1/payment_intents?limit=3&starting_after=${page1.body.data[2].id}`)
      .set(bearer(key));
    const succeeded = await request(t.app)
      .get("/v1/payment_intents?status=succeeded")
      .set(bearer(key));

    expect(page1.body.has_more).toBe(true);
    expect([...page1.body.data, ...page2.body.data].map((p: { id: string }) => p.id)).toEqual(
      [...ids].reverse(),
    );
    expect(page2.body.has_more).toBe(false);
    expect(succeeded.body.data.map((p: { id: string }) => p.id)).toEqual([ids[0]]);
  });

  it("analysts can read payments but not create them", async () => {
    await start();
    const { owner } = await merchantWithKey();
    const analyst = await addMember(t.app, owner, "analyst");

    expect(
      (await request(t.app).get("/v1/payment_intents").set(bearer(analyst.accessToken))).status,
    ).toBe(200);
    expect((await create(analyst.accessToken)).status).toBe(403);
  });
});
