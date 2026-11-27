import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Worker } from "bullmq";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { backoffDelay, dispatchEvents } from "../src/webhooks/delivery.js";
import type { WebhookDelivery } from "../src/webhooks/models.js";
import { startWebhookWorker } from "../src/webhooks/queue.js";
import {
  SecretBox,
  SignatureError,
  signatureHeader,
  verifySignature,
} from "../src/webhooks/signing.js";
import { checkUrlShape, isPublicAddress, type Lookup } from "../src/webhooks/ssrf.js";
import { addMember, bearer, signup, startTestApp, type TestApp } from "./helpers.js";

// ------------------------------------------------------------------ a merchant's server --

type Received = { headers: IncomingHttpHeaders; body: string; json: Record<string, unknown> };
type Reply = { status?: number; delayMs?: number; headers?: Record<string, string> };

/** A real HTTP server playing the merchant's webhook handler. */
class Receiver {
  received: Received[] = [];
  /** Played in order, one per request; after that, `fallback`. */
  replies: Reply[] = [];
  fallback: Reply = { status: 200 };
  private server: Server;

  constructor() {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        this.received.push({
          headers: req.headers,
          body,
          json: JSON.parse(body) as Record<string, unknown>,
        });
        const reply = this.replies.shift() ?? this.fallback;
        setTimeout(() => {
          res.writeHead(reply.status ?? 200, reply.headers);
          res.end(reply.status && reply.status >= 400 ? "handler crashed" : "ok");
        }, reply.delayMs ?? 0);
      });
    });
  }

  async start(): Promise<string> {
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/hooks`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    this.server.close();
    await once(this.server, "close");
  }

  ofType(type: string): Received[] {
    return this.received.filter((r) => r.json.type === type);
  }
}

// ---------------------------------------------------------------------------- set-up --

const FAST: Partial<Config["webhooks"]> = {
  allowPrivateUrls: true, // the receiver is on 127.0.0.1
  maxAttempts: 4,
  retryBaseMs: 20,
  retryMaxMs: 100,
  timeoutMs: 500,
  concurrency: 5,
  dispatchIntervalMs: 0, // the tests dispatch by hand
};

let t: TestApp;
let receiver: Receiver;
let worker: Worker | null = null;
let url: string;
let started = false;

afterEach(async () => {
  if (!started) return;
  started = false;
  await worker?.close();
  worker = null;
  await receiver.stop();
  await t.close();
});

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  probe.close();
  await once(probe, "close");
  return port;
}

async function start(
  webhooks: Partial<Config["webhooks"]> = {},
  webhookLookup?: Lookup,
): Promise<void> {
  const base = (await import("./helpers.js")).testConfig();
  t = await startTestApp({
    config: { webhooks: { ...base.webhooks, ...FAST, ...webhooks } },
    webhookLookup,
  });
  receiver = new Receiver();
  url = await receiver.start();
  started = true;
}

function runWorker(): void {
  worker = startWebhookWorker(t.app.locals.webhooks);
}

async function merchant() {
  const owner = await signup(t.app, { businessName: "Chai Point" });
  const created = await request(t.app)
    .post("/v1/api-keys")
    .set(bearer(owner.accessToken))
    .send({ name: "server", mode: "test" });
  return { owner, key: created.body.key as string };
}

async function addEndpoint(token: string, body: Record<string, unknown> = {}) {
  const res = await request(t.app)
    .post("/v1/webhook_endpoints")
    .set(bearer(token))
    .send({ url, enabled_events: ["*"], ...body });
  expect(res.status).toBe(201);
  return res.body as { id: string; secret: string; url: string; enabled_events: string[] };
}

async function paid(key: string, amount = 50_000): Promise<string> {
  const created = await request(t.app)
    .post("/v1/payment_intents")
    .set(bearer(key))
    .send({ amount, metadata: { order: "1001" } });
  await request(t.app)
    .post(`/v1/payment_intents/${created.body.id}/test_actions`)
    .set(bearer(key))
    .send({ outcome: "succeed" });
  return created.body.id as string;
}

async function waitFor<T>(check: () => Promise<T | null | undefined | false>, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const deliveries = (filter: Record<string, unknown> = {}) =>
  t.app.locals.models.WebhookDelivery.find(filter).lean<WebhookDelivery[]>();

async function settled(filter: Record<string, unknown> = {}): Promise<WebhookDelivery[]> {
  return waitFor(async () => {
    const rows = await deliveries(filter);
    return rows.length > 0 && rows.every((d) => d.status === "succeeded" || d.status === "dead")
      ? rows
      : null;
  });
}

// ------------------------------------------------------------------------- delivery --

describe("delivering events to merchants", () => {
  it("sends every event, signed, with the object as it was", async () => {
    await start();
    const { owner, key } = await merchant();
    const endpoint = await addEndpoint(owner.accessToken, { description: "orders service" });
    runWorker();

    const intentId = await paid(key);
    expect(await dispatchEvents(t.app.locals.webhooks)).toBe(2);
    const done = await settled();

    expect(done.map((d) => d.status)).toEqual(["succeeded", "succeeded"]);
    expect(receiver.received.map((r) => r.json.type).sort()).toEqual([
      "payment_intent.created",
      "payment_intent.succeeded",
    ]);
    const [succeeded] = receiver.ofType("payment_intent.succeeded");
    expect(succeeded).toBeDefined();
    if (!succeeded) return;
    const signature = succeeded.headers["payguard-signature"] as string;
    expect(() => verifySignature(signature, succeeded.body, endpoint.secret)).not.toThrow();
    expect(succeeded.json).toMatchObject({
      object: "event",
      livemode: false,
      data: {
        object: {
          id: intentId,
          object: "payment_intent",
          status: "succeeded",
          amount: 50_000,
          metadata: { order: "1001" },
        },
      },
    });
    // The client secret is for the customer's browser, never for webhooks
    expect(succeeded.body).not.toContain("client_secret");
    // created's snapshot is from before the payment succeeded
    expect(receiver.ofType("payment_intent.created")[0]?.json).toMatchObject({
      data: { object: { status: "requires_payment" } },
    });
    expect(succeeded.headers["payguard-event-id"]).toBe(succeeded.json.id);
    expect(succeeded.headers["payguard-attempt"]).toBe("1");
    expect(succeeded.headers["content-type"]).toBe("application/json");

    const log = await request(t.app)
      .get(`/v1/webhook_deliveries/${done[0]?._id}`)
      .set(bearer(owner.accessToken));
    expect(log.body).toMatchObject({
      status: "succeeded",
      attempt_count: 1,
      endpoint: endpoint.id,
      attempts: [{ status_code: 200, error: null, response_body: "ok" }],
    });
    // Secrets are never shown again, and stored encrypted
    const listed = await request(t.app).get("/v1/webhook_endpoints").set(bearer(owner.accessToken));
    expect(JSON.stringify(listed.body)).not.toContain("whsec_");
    const stored = await t.app.locals.models.WebhookEndpoint.findById(endpoint.id).lean();
    expect(JSON.stringify(stored)).not.toContain(endpoint.secret);
  });

  it("sends only the events an endpoint asked for, in its mode, from when it was added", async () => {
    await start();
    const { owner, key } = await merchant();
    const earlier = await paid(key); // before any endpoint existed
    const onlySucceeded = await addEndpoint(owner.accessToken, {
      enabled_events: ["payment_intent.succeeded"],
    });
    await addEndpoint(owner.accessToken, { mode: "live" });
    runWorker();

    const later = await paid(key);
    await dispatchEvents(t.app.locals.webhooks);
    const done = await settled();

    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({
      endpointId: onlySucceeded.id,
      eventType: "payment_intent.succeeded",
    });
    expect(receiver.received).toHaveLength(1);
    expect(receiver.received[0]?.json).toMatchObject({ data: { object: { id: later } } });
    expect(receiver.received[0]?.body).not.toContain(earlier);
  });

  it("dispatching twice (a crash, two instances) still delivers each event once", async () => {
    await start();
    const { owner, key } = await merchant();
    await addEndpoint(owner.accessToken);
    await paid(key);

    // Two dispatchers at once
    const counts = await Promise.all([
      dispatchEvents(t.app.locals.webhooks),
      dispatchEvents(t.app.locals.webhooks),
    ]);
    // A dispatcher that crashed after queueing, before marking the event done: taken over
    await t.app.locals.models.PaymentEvent.updateMany(
      {},
      { $set: { deliveredAt: null, fanoutClaimedAt: null } },
    );
    await dispatchEvents(t.app.locals.webhooks);
    runWorker();
    await settled();

    expect(counts[0] + counts[1]).toBe(2);
    expect(await deliveries()).toHaveLength(2);
    expect(receiver.received).toHaveLength(2);
  });

  it("retries failures with backoff until the merchant's server answers 2xx", async () => {
    await start();
    const { owner, key } = await merchant();
    await addEndpoint(owner.accessToken, { enabled_events: ["payment_intent.succeeded"] });
    receiver.replies = [{ status: 500 }, { status: 502 }];
    runWorker();

    await paid(key);
    await dispatchEvents(t.app.locals.webhooks);
    const [delivery] = await settled();

    expect(delivery).toMatchObject({ status: "succeeded", attemptCount: 3, nextAttemptAt: null });
    expect(delivery?.attempts.map((a) => a.statusCode)).toEqual([500, 502, 200]);
    expect(delivery?.attempts[0]?.error).toBe("HTTP 500");
    expect(receiver.received.map((r) => r.headers["payguard-attempt"])).toEqual(["1", "2", "3"]);
    // The same event each time: the merchant deduplicates by its id
    expect(new Set(receiver.received.map((r) => r.json.id)).size).toBe(1);
  });

  it("gives up after the last attempt (dead-letter queue), and can be replayed", async () => {
    await start();
    const { owner, key } = await merchant();
    const endpoint = await addEndpoint(owner.accessToken, {
      enabled_events: ["payment_intent.succeeded"],
    });
    receiver.fallback = { status: 503 };
    runWorker();

    await paid(key);
    await dispatchEvents(t.app.locals.webhooks);
    const [dead] = await settled();

    expect(dead).toMatchObject({ status: "dead", attemptCount: 4 });
    const queue = await request(t.app)
      .get("/v1/webhook_deliveries?status=dead")
      .set(bearer(owner.accessToken));
    expect(queue.body.data.map((d: { id: string }) => d.id)).toEqual([dead?._id]);
    expect(queue.body.data[0].last_response).toMatchObject({ statusCode: 503 });

    // The merchant fixes their handler and replays it
    receiver.fallback = { status: 200 };
    const replay = await request(t.app)
      .post(`/v1/webhook_deliveries/${dead?._id}/retry`)
      .set(bearer(owner.accessToken));
    expect(replay.status).toBe(202);
    const replayed = await waitFor(async () => {
      const row = await t.app.locals.models.WebhookDelivery.findById(dead?._id).lean();
      return row?.status === "succeeded" ? row : null;
    });
    expect(replayed).toMatchObject({ replays: 1, attemptCount: 5 });
    const again = await request(t.app)
      .post(`/v1/webhook_deliveries/${dead?._id}/retry`)
      .set(bearer(owner.accessToken));
    expect(again.status).toBe(202); // resending a delivered one is allowed (it's manual)
    await waitFor(async () => {
      const row = await t.app.locals.models.WebhookDelivery.findById(dead?._id).lean();
      return row?.status === "succeeded" && row.attemptCount === 6;
    });

    // Bulk replay of everything dead on the endpoint
    receiver.fallback = { status: 500 };
    await paid(key);
    await paid(key);
    await dispatchEvents(t.app.locals.webhooks);
    await waitFor(async () => (await deliveries({ status: "dead" })).length === 2);
    receiver.fallback = { status: 200 };
    const bulk = await request(t.app)
      .post(`/v1/webhook_endpoints/${endpoint.id}/retry_dead`)
      .set(bearer(owner.accessToken));
    expect(bulk.body).toEqual({ replayed: 2 });
    await waitFor(async () => (await deliveries({ status: "succeeded" })).length === 3);
  });

  it("counts a slow answer, a redirect, and an unreachable server as failures", async () => {
    await start({ maxAttempts: 1, timeoutMs: 200 });
    const { owner, key } = await merchant();
    const slow = await addEndpoint(owner.accessToken, {
      enabled_events: ["payment_intent.created"],
    });
    const gone = await addEndpoint(owner.accessToken, {
      enabled_events: ["payment_intent.created"],
      url: `http://127.0.0.1:${await closedPort()}/nothing-listens-here`,
    });
    receiver.replies = [{ delayMs: 1000 }];
    runWorker();

    await paid(key);
    await dispatchEvents(t.app.locals.webhooks);
    const done = await settled();
    const of = (id: string) => done.find((d) => d.endpointId === id)?.attempts[0];

    expect(of(slow.id)).toMatchObject({ statusCode: null, error: "Timed out" });
    expect(of(gone.id)?.error).toMatch(/Couldn't connect \(ECONNREFUSED\)/);

    // A redirect isn't followed: it could lead into our own network
    await t.app.locals.models.WebhookDelivery.deleteMany({});
    receiver.replies = [{ status: 302, headers: { Location: "http://169.254.169.254/" } }];
    await request(t.app)
      .patch(`/v1/webhook_endpoints/${gone.id}`)
      .set(bearer(owner.accessToken))
      .send({ status: "disabled" });
    await paid(key);
    await dispatchEvents(t.app.locals.webhooks);
    const [redirected] = await settled({ endpointId: slow.id });
    expect(redirected?.attempts[0]).toMatchObject({ statusCode: 302, error: "HTTP 302" });
    expect(receiver.received).toHaveLength(2);
  });

  it("a deleted or disabled endpoint's queued deliveries stop", async () => {
    await start();
    const { owner, key } = await merchant();
    const endpoint = await addEndpoint(owner.accessToken, {
      enabled_events: ["payment_intent.succeeded"],
    });
    await paid(key);
    await dispatchEvents(t.app.locals.webhooks);
    await request(t.app)
      .delete(`/v1/webhook_endpoints/${endpoint.id}`)
      .set(bearer(owner.accessToken))
      .expect(204);
    runWorker();

    const [delivery] = await settled();

    expect(delivery?.status).toBe("dead");
    expect(delivery?.attempts[0]?.error).toBe("The endpoint was deleted");
    expect(receiver.received).toHaveLength(0);
  });

  it("a test ping checks an endpoint with one attempt", async () => {
    await start();
    const { owner } = await merchant();
    const endpoint = await addEndpoint(owner.accessToken);
    runWorker();

    const res = await request(t.app)
      .post(`/v1/webhook_endpoints/${endpoint.id}/test`)
      .set(bearer(owner.accessToken));

    expect(res.status).toBe(202);
    const [ping] = await settled({ _id: res.body.id });
    expect(ping?.status).toBe("succeeded");
    expect(receiver.received[0]?.json).toMatchObject({
      type: "ping",
      data: { object: { endpoint: endpoint.id } },
    });
  });
});

// ------------------------------------------------------------------- secret rotation --

describe("rotating the signing secret", () => {
  it("signs with both secrets during the grace period, then only the new one", async () => {
    await start();
    const { owner, key } = await merchant();
    const endpoint = await addEndpoint(owner.accessToken, {
      enabled_events: ["payment_intent.succeeded"],
    });
    runWorker();

    const rotated = await request(t.app)
      .post(`/v1/webhook_endpoints/${endpoint.id}/rotate_secret`)
      .set(bearer(owner.accessToken))
      .send({});
    await paid(key);
    await dispatchEvents(t.app.locals.webhooks);
    await settled();

    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(endpoint.secret);
    expect(rotated.body.previous_secret_expires_at).toEqual(expect.any(String));
    const [hook] = receiver.received;
    const header = hook?.headers["payguard-signature"] as string;
    expect(header.match(/v1=/g)).toHaveLength(2);
    for (const secret of [endpoint.secret, rotated.body.secret as string]) {
      expect(() => verifySignature(header, hook?.body ?? "", secret)).not.toThrow();
    }

    // Rotating at once (no grace period): the old secret stops working immediately
    const now = await request(t.app)
      .post(`/v1/webhook_endpoints/${endpoint.id}/rotate_secret`)
      .set(bearer(owner.accessToken))
      .send({ expire_previous_in_hours: 0 });
    await paid(key);
    await dispatchEvents(t.app.locals.webhooks);
    await waitFor(() => Promise.resolve(receiver.received.length === 2));
    const next = receiver.received[1];
    const nextHeader = next?.headers["payguard-signature"] as string;
    expect(nextHeader.match(/v1=/g)).toHaveLength(1);
    expect(() => verifySignature(nextHeader, next?.body ?? "", now.body.secret)).not.toThrow();
    expect(() => verifySignature(nextHeader, next?.body ?? "", rotated.body.secret)).toThrow(
      SignatureError,
    );
  });
});

// ----------------------------------------------------------------------------- SSRF --

describe("webhook URLs can't reach our own network", () => {
  const fakeDns =
    (answers: Record<string, string[]>): Lookup =>
    (hostname) => {
      const found = answers[hostname];
      if (!found) return Promise.reject(new Error("ENOTFOUND"));
      return Promise.resolve(
        found.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      );
    };

  it("refuses private, loopback, link-local and unresolvable hosts", async () => {
    const dns = fakeDns({
      "hooks.example.com": ["93.184.216.34"],
      "internal.example.com": ["10.0.0.7"],
      "sneaky.example.com": ["93.184.216.34", "127.0.0.1"],
      "v6.example.com": ["fd00::1"],
    });
    await start({ allowPrivateUrls: false }, dns);
    const { owner } = await merchant();
    const attempt = (target: string) =>
      request(t.app)
        .post("/v1/webhook_endpoints")
        .set(bearer(owner.accessToken))
        .send({ url: target, enabled_events: ["*"] });

    for (const target of [
      "http://127.0.0.1:6379/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:10.0.0.1]/",
      "http://internal.example.com/hooks",
      "http://sneaky.example.com/hooks", // one private answer is enough
      "http://v6.example.com/hooks",
      "http://nowhere.example.com/hooks",
      "ftp://hooks.example.com/",
      "http://user:pass@hooks.example.com/",
    ]) {
      const res = await attempt(target);
      expect(res.status, target).toBe(422);
      expect(res.body.error.code, target).toBe("invalid_url");
    }
    expect((await attempt("http://hooks.example.com/payguard")).status).toBe(201);
  });

  it("checks again when connecting: a host that rebinds to a private address gets nothing", async () => {
    const answers: Record<string, string[]> = { "rebind.example.com": ["93.184.216.34"] };
    await start({ allowPrivateUrls: false, maxAttempts: 5 }, fakeDns(answers));
    const { owner, key } = await merchant();
    await addEndpoint(owner.accessToken, {
      url: "http://rebind.example.com/hooks",
      enabled_events: ["payment_intent.succeeded"],
    });
    // After the URL was checked, the attacker's DNS starts answering with localhost
    answers["rebind.example.com"] = ["127.0.0.1"];
    runWorker();

    await paid(key);
    await dispatchEvents(t.app.locals.webhooks);
    const [delivery] = await settled();

    // Straight to the dead-letter queue: waiting won't make the address safe
    expect(delivery).toMatchObject({ status: "dead", attemptCount: 1 });
    expect(delivery?.attempts[0]?.error).toBe("rebind.example.com resolves to a private address");
    expect(receiver.received).toHaveLength(0);
  });

  it("classifies addresses", () => {
    for (const address of [
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "127.0.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:192.168.0.1",
      "not-an-ip",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    expect(() => checkUrlShape("http://hooks.example.com/", { production: true })).toThrow(/https/);
    expect(checkUrlShape("https://hooks.example.com/x", { production: true }).hostname).toBe(
      "hooks.example.com",
    );
  });
});

// ------------------------------------------------------------------------ the API --

describe("managing endpoints", () => {
  it("validates, limits who can change them, and keeps merchants apart", async () => {
    await start();
    const { owner, key } = await merchant();
    const other = await merchant();
    const analyst = await addMember(t.app, owner, "analyst");
    const endpoint = await addEndpoint(owner.accessToken, {
      enabled_events: ["refund.succeeded", "refund.succeeded"],
    });

    const unknownEvent = await request(t.app)
      .post("/v1/webhook_endpoints")
      .set(bearer(owner.accessToken))
      .send({ url, enabled_events: ["payment_intent.exploded"] });
    const analystRead = await request(t.app)
      .get("/v1/webhook_endpoints")
      .set(bearer(analyst.accessToken));
    const analystWrite = await request(t.app)
      .post("/v1/webhook_endpoints")
      .set(bearer(analyst.accessToken))
      .send({ url, enabled_events: ["*"] });
    const withApiKey = await request(t.app).get("/v1/webhook_endpoints").set(bearer(key));
    const foreign = await request(t.app)
      .get(`/v1/webhook_endpoints/${endpoint.id}`)
      .set(bearer(other.owner.accessToken));
    const updated = await request(t.app)
      .patch(`/v1/webhook_endpoints/${endpoint.id}`)
      .set(bearer(owner.accessToken))
      .send({ enabled_events: ["*"], description: "all of it" });

    expect(endpoint.enabled_events).toEqual(["refund.succeeded"]);
    expect(unknownEvent.status).toBe(422);
    expect(analystRead.status).toBe(200);
    expect(analystRead.body.data).toHaveLength(1);
    expect(analystWrite.status).toBe(403);
    expect(withApiKey.status).toBe(403);
    expect(foreign.status).toBe(404);
    expect(updated.body).toMatchObject({ enabled_events: ["*"], description: "all of it" });
  });
});

// ------------------------------------------------------------------------------ units --

describe("signatures, encryption and backoff", () => {
  it("verifies like a merchant's server would", () => {
    const body = '{"id":"evt_1"}';
    const now = 1_764_230_400_000;
    const header = signatureHeader(["whsec_a"], now / 1000, body);

    expect(verifySignature(header, body, "whsec_a", { now })).toEqual({ timestamp: now / 1000 });
    expect(() => verifySignature(header, `${body} `, "whsec_a", { now })).toThrow(/No signature/);
    expect(() => verifySignature(header, body, "whsec_b", { now })).toThrow(/No signature/);
    expect(() => verifySignature(header, body, "whsec_a", { now: now + 301_000 })).toThrow(
      /tolerance/,
    );
    expect(() => verifySignature("v1=abc", body, "whsec_a", { now })).toThrow(/Malformed/);
    expect(() => verifySignature(undefined, body, "whsec_a", { now })).toThrow(/No signature/);
  });

  it("encrypts secrets with authenticated encryption", () => {
    const box = new SecretBox(Buffer.alloc(32, 7).toString("base64url"));
    const sealed = box.encrypt("whsec_secret");
    expect(sealed).not.toContain("whsec");
    expect(box.decrypt(sealed)).toBe("whsec_secret");
    expect(box.encrypt("whsec_secret")).not.toBe(sealed); // a fresh IV each time
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => box.decrypt(parts.join("."))).toThrow();
    const otherKey = new SecretBox(Buffer.alloc(32, 8).toString("base64url"));
    expect(() => otherKey.decrypt(sealed)).toThrow();
  });

  it("backs off exponentially, capped, with full jitter", () => {
    const limits = { retryBaseMs: 1000, retryMaxMs: 60_000 };
    expect([1, 2, 3, 4, 10].map((n) => backoffDelay(n, limits, () => 0.999999))).toEqual([
      999, 1999, 3999, 7999, 59_999,
    ]);
    expect(backoffDelay(5, limits, () => 0)).toBe(1);
    const spread = new Set(Array.from({ length: 50 }, () => backoffDelay(6, limits)));
    expect(spread.size).toBeGreaterThan(40); // retries don't arrive in lockstep
  });
});
