import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

import type { Config } from "../config.js";
import { attemptDelivery, dispatchEvents, type DeliveryJob, type WebhookDeps } from "./delivery.js";

export const QUEUE_NAME = "webhook-deliveries";

/** BullMQ needs its own connection, with no per-command retry limit (it blocks on Redis). */
function connection(config: Config): Redis {
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
}

export type DeliveryQueue = {
  add: (name: string, data: DeliveryJob, opts?: JobsOptions) => Promise<unknown>;
  addBulk: (jobs: { name: string; data: DeliveryJob; opts?: JobsOptions }[]) => Promise<unknown>;
  close: () => Promise<void>;
};

/** Connects on first use, so an app that never queues a webhook never opens a connection. */
export function createWebhookQueue(config: Config): DeliveryQueue {
  let queue: Queue<DeliveryJob> | undefined;
  const get = () =>
    (queue ??= new Queue<DeliveryJob>(QUEUE_NAME, {
      connection: connection(config),
      prefix: "payguard",
    }));
  return {
    add: (name, data, opts) => get().add(name, data, opts),
    addBulk: (jobs) => get().addBulk(jobs),
    close: async () => {
      await queue?.close();
    },
  };
}

/** Thrown by the processor so BullMQ retries, with the delay attemptDelivery chose. */
class RetryLater extends Error {
  constructor(readonly delayMs: number) {
    super(`Retrying in ${delayMs} ms`);
  }
}

export function startWebhookWorker(deps: WebhookDeps): Worker<DeliveryJob> {
  const worker = new Worker<DeliveryJob>(
    QUEUE_NAME,
    async (job: Job<DeliveryJob>) => {
      const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const result = await attemptDelivery(deps, job.data.deliveryId, {
        final,
        attemptsMade: job.attemptsMade,
      });
      if (result.outcome === "retry") throw new RetryLater(result.retryInMs);
      return result.outcome;
    },
    {
      connection: connection(deps.config),
      prefix: "payguard",
      concurrency: deps.config.webhooks.concurrency,
      settings: {
        backoffStrategy: (_attemptsMade, _type, err) =>
          err instanceof RetryLater ? err.delayMs : deps.config.webhooks.retryBaseMs,
      },
    },
  );
  worker.on("error", (err) => {
    deps.logger.error({ err }, "Webhook worker error");
  });
  return worker;
}

/** Polls the outbox. Returns a function that stops it (and waits for the current pass). */
export function startDispatcher(deps: WebhookDeps): () => Promise<void> {
  const interval = deps.config.webhooks.dispatchIntervalMs;
  if (interval === 0) return () => Promise.resolve();
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = (async () => {
      try {
        // Keep going while there's a backlog, then wait for the next interval
        while (!stopped && (await dispatchEvents(deps)) > 0) {
          /* drain */
        }
      } catch (err) {
        deps.logger.error({ err }, "Webhook dispatch pass failed");
      }
      if (!stopped) timer = setTimeout(tick, interval).unref();
    })();
  };
  timer = setTimeout(tick, interval).unref();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}
