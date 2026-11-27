/**
 * Getting events to merchants, reliably:
 *
 *   payment_events (written in the same transaction as the change: the outbox)
 *     └─ dispatcher: one delivery per subscribed endpoint, queued in BullMQ
 *          └─ worker: signed POST; non-2xx or no answer → retry with exponential backoff
 *             and full jitter; after the last attempt → "dead" (the dead-letter queue),
 *             from where a merchant can replay it
 *
 * Every step is safe to repeat. A dispatcher that crashes mid-event is taken over after a
 * minute; the unique (event, endpoint) index keeps it to one delivery each, and the job id is
 * the delivery id, so BullMQ keeps it to one job. A worker never re-sends a delivery that has
 * already succeeded. Merchants still see a duplicate now and then (we sent it, their 200 got
 * lost), so the docs tell them to deduplicate by event id, as with every webhook provider.
 */
import { fetch, type Agent } from "undici";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Models } from "../models/index.js";
import type { PaymentEvent } from "../payments/models.js";
import { SecretBox, SIGNATURE_HEADER, signatureHeader } from "./signing.js";
import { checkLiteralHost, UnsafeUrlError } from "./ssrf.js";
import type { WebhookDelivery, WebhookEndpoint } from "./models.js";
import type { DeliveryQueue } from "./queue.js";

export type DeliveryJob = { deliveryId: string };

export type WebhookDeps = {
  config: Config;
  logger: Logger;
  models: Models;
  queue: DeliveryQueue;
  agent: Agent;
};

const RESPONSE_BODY_CHARS = 1000;
const KEPT_ATTEMPTS = 25;
const CLAIM_TIMEOUT_MS = 60_000;

/** Full jitter (AWS's name): random in [0, min(cap, base × 2^(attempt-1))], at least 1 ms. */
export function backoffDelay(
  attemptsMade: number,
  { retryBaseMs, retryMaxMs }: Pick<Config["webhooks"], "retryBaseMs" | "retryMaxMs">,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.max(0, attemptsMade - 1));
  return Math.max(1, Math.floor(random() * ceiling));
}

export function jobOptions(config: Config, jobId: string) {
  return {
    jobId,
    attempts: config.webhooks.maxAttempts,
    backoff: { type: "jittered" },
    removeOnComplete: { age: 24 * 60 * 60, count: 10_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  };
}

export function eventPayload(
  event: Pick<PaymentEvent, "_id" | "type" | "mode" | "data" | "createdAt">,
) {
  const data = event.data as { object?: unknown };
  return {
    id: event._id,
    object: "event",
    type: event.type,
    created: Math.floor(new Date(event.createdAt).getTime() / 1000),
    livemode: event.mode === "live",
    // Events from before snapshots were stored carry their summary instead
    data: { object: data.object ?? data },
  };
}

/** Turns undelivered events into deliveries and queues them. Returns how many events. */
export async function dispatchEvents(
  deps: WebhookDeps,
  { now = new Date(), batchSize = 100 }: { now?: Date; batchSize?: number } = {},
): Promise<number> {
  const { models, queue, config } = deps;
  let dispatched = 0;
  while (dispatched < batchSize) {
    const event = await models.PaymentEvent.findOneAndUpdate(
      {
        deliveredAt: null,
        $or: [
          { fanoutClaimedAt: null },
          { fanoutClaimedAt: { $lt: new Date(now.getTime() - CLAIM_TIMEOUT_MS) } },
        ],
      },
      { $set: { fanoutClaimedAt: now } },
      { sort: { createdAt: 1, _id: 1 }, returnDocument: "after" },
    ).lean<PaymentEvent>();
    if (!event) break;
    const endpoints = await models.WebhookEndpoint.find({
      merchantId: event.merchantId,
      mode: event.mode,
      status: "enabled",
      // Endpoints get the events that happen after they're added, not the history
      createdAt: { $lte: event.createdAt },
      enabledEvents: { $in: [event.type, "*"] },
    }).lean<WebhookEndpoint[]>();
    if (endpoints.length > 0) {
      try {
        await models.WebhookDelivery.insertMany(
          endpoints.map((endpoint) => ({
            merchantId: event.merchantId,
            mode: event.mode,
            endpointId: endpoint._id,
            eventId: event._id,
            eventType: event.type,
          })),
          { ordered: false },
        );
      } catch (err) {
        // A previous, crashed run of this event made some of them already
        if ((err as { code?: number }).code !== 11000) throw err;
      }
      const deliveries = await models.WebhookDelivery.find({
        eventId: event._id,
        status: "pending",
        attemptCount: 0,
      }).lean<WebhookDelivery[]>();
      await queue.addBulk(
        deliveries.map((d) => ({
          name: "deliver",
          data: { deliveryId: d._id },
          opts: jobOptions(config, d._id),
        })),
      );
    }
    await models.PaymentEvent.updateOne({ _id: event._id }, { $set: { deliveredAt: now } });
    dispatched++;
  }
  return dispatched;
}

export type AttemptResult =
  { outcome: "succeeded" | "dead" | "skipped" } | { outcome: "retry"; retryInMs: number };

async function readStart(response: Awaited<ReturnType<typeof fetch>>): Promise<string> {
  // Only the start of what they answered: some error pages are megabytes
  const body = response.body;
  if (!body) return "";
  const decoder = new TextDecoder();
  let text = "";
  try {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length >= RESPONSE_BODY_CHARS) break;
    }
  } catch {
    // They closed the connection mid-body: what we have is enough
  }
  return text.slice(0, RESPONSE_BODY_CHARS);
}

function errorText(err: unknown): string {
  if (err instanceof UnsafeUrlError) return err.message;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof UnsafeUrlError) return cause.message;
  if (err instanceof Error && err.name === "TimeoutError") return "Timed out";
  const code = (cause as { code?: string } | undefined)?.code;
  if (code) return `Couldn't connect (${code})`;
  if (cause instanceof Error) return cause.message;
  return err instanceof Error ? err.message : String(err);
}

function isUnsafe(err: unknown): boolean {
  return (
    err instanceof UnsafeUrlError || (err as { cause?: unknown }).cause instanceof UnsafeUrlError
  );
}

/**
 * One attempt at one delivery. `final`: whether a failure now goes to the dead-letter queue
 * instead of being retried.
 */
export async function attemptDelivery(
  deps: WebhookDeps,
  deliveryId: string,
  { final, attemptsMade }: { final: boolean; attemptsMade: number },
): Promise<AttemptResult> {
  const { models, config, logger } = deps;
  const delivery = await models.WebhookDelivery.findById(deliveryId).lean<WebhookDelivery>();
  // Gone (expired), or already delivered by an earlier copy of this job
  if (!delivery || delivery.status === "succeeded") return { outcome: "skipped" };
  const endpoint = await models.WebhookEndpoint.findById(
    delivery.endpointId,
  ).lean<WebhookEndpoint>();

  const record = async (
    status: WebhookDelivery["status"],
    attempt: Record<string, unknown> | null,
    set: Record<string, unknown> = {},
  ) => {
    await models.WebhookDelivery.updateOne(
      { _id: deliveryId, status: { $ne: "succeeded" } },
      {
        $set: { status, ...set },
        ...(attempt
          ? {
              $inc: { attemptCount: 1 },
              $push: { attempts: { $each: [attempt], $slice: -KEPT_ATTEMPTS } },
            }
          : {}),
      },
    );
  };

  if (!endpoint || endpoint.status !== "enabled") {
    await record(
      "dead",
      {
        at: new Date(),
        statusCode: null,
        durationMs: 0,
        error: endpoint ? "The endpoint is disabled" : "The endpoint was deleted",
        responseBody: null,
      },
      { nextAttemptAt: null, lastAttemptAt: new Date() },
    );
    return { outcome: "dead" };
  }

  let payload: unknown = delivery.payload;
  if (!payload) {
    const event = await models.PaymentEvent.findById(delivery.eventId).lean<PaymentEvent>();
    if (!event) return { outcome: "skipped" };
    payload = eventPayload(event);
  }
  const body = JSON.stringify(payload);
  const now = new Date();
  const box = new SecretBox(config.webhooks.secretsKey);
  const secrets = endpoint.secrets
    .filter((s) => !s.expiresAt || s.expiresAt > now)
    .map((s) => box.decrypt(s.encrypted));
  const timestamp = Math.floor(now.getTime() / 1000);

  const started = performance.now();
  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let error: string | null = null;
  let unsafe = false;
  try {
    const url = new URL(endpoint.url);
    checkLiteralHost(url, config.webhooks.allowPrivateUrls);
    const response = await fetch(url, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PayGuard-Webhooks/1.0",
        [SIGNATURE_HEADER]: signatureHeader(secrets, timestamp, body),
        "PayGuard-Event-Id": delivery.eventId,
        "PayGuard-Delivery-Id": delivery._id,
        "PayGuard-Attempt": String(delivery.attemptCount + 1),
      },
      // A redirect could point anywhere, including inside our network
      redirect: "manual",
      dispatcher: deps.agent,
      signal: AbortSignal.timeout(config.webhooks.timeoutMs),
    });
    statusCode = response.status;
    responseBody = await readStart(response);
    if (!response.ok) error = `HTTP ${response.status}`;
  } catch (err) {
    error = errorText(err);
    unsafe = isUnsafe(err);
  }
  const attempt = {
    at: now,
    statusCode,
    durationMs: Math.round(performance.now() - started),
    error,
    responseBody,
  };

  if (error === null) {
    await record("succeeded", attempt, {
      succeededAt: new Date(),
      lastAttemptAt: now,
      nextAttemptAt: null,
    });
    return { outcome: "succeeded" };
  }
  // A URL that now resolves to a private address won't fix itself by waiting
  if (final || unsafe) {
    await record("dead", attempt, { lastAttemptAt: now, nextAttemptAt: null });
    logger.warn(
      { deliveryId, endpointId: endpoint._id, eventType: delivery.eventType, error },
      "Webhook delivery failed for good: in the dead-letter queue",
    );
    return { outcome: "dead" };
  }
  const retryInMs = backoffDelay(attemptsMade + 1, config.webhooks);
  await record("retrying", attempt, {
    lastAttemptAt: now,
    nextAttemptAt: new Date(now.getTime() + retryInMs),
  });
  return { outcome: "retry", retryInMs };
}

/** Puts a delivery back on the queue: a manual retry, from the dead-letter queue or not. */
export async function replayDelivery(deps: WebhookDeps, delivery: WebhookDelivery): Promise<void> {
  const replays = delivery.replays + 1;
  await deps.models.WebhookDelivery.updateOne(
    { _id: delivery._id },
    { $set: { status: "pending", nextAttemptAt: new Date() }, $inc: { replays: 1 } },
  );
  await deps.queue.add(
    "deliver",
    { deliveryId: delivery._id },
    jobOptions(deps.config, `${delivery._id}-replay-${replays}`),
  );
}
