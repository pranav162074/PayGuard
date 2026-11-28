import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";

import type { Config } from "../config.js";
import type { KeyMode } from "../models/index.js";
import { previousIstDay, runReconciliation, type ReconDeps } from "./service.js";

export const RECON_QUEUE = "reconciliation";
const SCHEDULER_ID = "nightly-reconciliation";

export type ReconJob = { date?: string; modes?: KeyMode[] };

const connection = (config: Config) => new Redis(config.redisUrl, { maxRetriesPerRequest: null });

/** Reconciles a day in every mode that has Razorpay keys. */
export async function reconcileDay(
  deps: ReconDeps,
  config: Config,
  job: ReconJob,
  now = new Date(),
): Promise<string[]> {
  const date = job.date ?? previousIstDay(now);
  const modes = (job.modes ?? (["test", "live"] as const)).filter((m) => deps.gateways[m]);
  const runs: string[] = [];
  for (const mode of modes) {
    const run = await runReconciliation(deps, {
      mode,
      date,
      now,
      overdueDays: config.reconciliation.overdueDays,
    });
    runs.push(run._id);
  }
  return runs;
}

/**
 * The nightly run, as a BullMQ job scheduler: every instance can call this, and BullMQ keeps
 * one schedule and runs each night's job once. A failed night is retried three times, an
 * hour apart, before it's left failed (and the run says so).
 */
export async function startReconciliationScheduler(
  deps: ReconDeps,
  config: Config,
): Promise<() => Promise<void>> {
  const { cron, timezone } = config.reconciliation;
  if (!cron) return () => Promise.resolve();
  const queue = new Queue<ReconJob>(RECON_QUEUE, {
    connection: connection(config),
    prefix: "payguard",
  });
  await queue.upsertJobScheduler(
    SCHEDULER_ID,
    { pattern: cron, tz: timezone },
    {
      name: "reconcile",
      data: {},
      opts: {
        attempts: 3,
        backoff: { type: "fixed", delay: 60 * 60 * 1000 },
        removeOnComplete: { count: 60 },
        removeOnFail: { count: 60 },
      },
    },
  );
  const worker = new Worker<ReconJob>(RECON_QUEUE, (job) => reconcileDay(deps, config, job.data), {
    connection: connection(config),
    prefix: "payguard",
    concurrency: 1,
  });
  worker.on("failed", (job, err) => {
    deps.logger.error({ err, attempt: job?.attemptsMade }, "Nightly reconciliation failed");
  });
  return async () => {
    await worker.close();
    await queue.close();
  };
}
