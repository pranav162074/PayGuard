import type { Redis } from "ioredis";
import type { Connection } from "mongoose";

export type CheckStatus = "up" | "down";
export type CheckResult = { status: CheckStatus; latencyMs: number; error?: string };
export type Check = () => Promise<void>;

/** A failure reason that is safe to show publicly. Details go to the logs, not the response. */
export class CheckFailure extends Error {
  override name = "CheckFailure";
}

class Timeout extends Error {}

async function withTimeout(check: Check, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Timeout());
    }, ms);
  });
  try {
    await Promise.race([check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function timed(check: Check, ms: number): Promise<CheckResult> {
  const started = performance.now();
  const latency = () => Math.round((performance.now() - started) * 10) / 10;
  try {
    await withTimeout(check, ms);
    return { status: "up", latencyMs: latency() };
  } catch (err) {
    const error =
      err instanceof Timeout
        ? "timeout"
        : err instanceof CheckFailure
          ? err.message
          : "unavailable";
    return { status: "down", latencyMs: latency(), error };
  }
}

/** Runs all checks at once, so readiness takes as long as the slowest check, not the sum. */
export async function runChecks(
  checks: Record<string, Check>,
  timeoutMs: number,
): Promise<{ ready: boolean; checks: Record<string, CheckResult> }> {
  const names = Object.keys(checks);
  const results = await Promise.all(names.map((name) => timed(checks[name] as Check, timeoutMs)));
  const byName = Object.fromEntries(names.map((name, i) => [name, results[i] as CheckResult]));
  return { ready: results.every((r) => r.status === "up"), checks: byName };
}

export function mongoCheck(connection: Connection): Check {
  return async () => {
    const db = connection.db;
    if (!db) throw new CheckFailure("not_connected");
    const hello = await db.admin().command({ hello: 1 });
    // Transactions (which the ledger relies on) only work on a replica set primary
    if (!hello.setName) throw new CheckFailure("not_replica_set");
    if (!hello.isWritablePrimary) throw new CheckFailure("not_primary");
  };
}

export function redisCheck(redis: Redis): Check {
  return async () => {
    await redis.ping();
  };
}
