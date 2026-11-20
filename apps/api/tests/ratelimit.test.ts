import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createLogger } from "../src/logger.js";
import { RateLimiter } from "../src/ratelimit.js";
import { createRedis } from "../src/redis.js";
import { testConfig } from "./helpers.js";

const redis = createRedis(testConfig().redisUrl, () => undefined);
await redis.connect();
const logger = createLogger("silent");

let now = 0;
const limiter = new RateLimiter(redis, logger, () => now);

beforeEach(async () => {
  await redis.flushdb();
  // Start exactly on a window boundary, so the arithmetic below is easy to follow
  now = 1_000_000 * 60_000;
});

afterAll(() => {
  redis.disconnect();
});

async function hits(count: number, limit = 10): Promise<boolean[]> {
  const results: boolean[] = [];
  for (let i = 0; i < count; i += 1) results.push((await limiter.hit("k", limit, 60)).allowed);
  return results;
}

describe("RateLimiter", () => {
  it("allows up to the limit, then blocks", async () => {
    const results = await hits(12);

    expect(results.filter(Boolean)).toHaveLength(10);
    expect(results.slice(10)).toEqual([false, false]);
  });

  it("reports what's left and when the window resets", async () => {
    now += 15_000;
    const first = await limiter.hit("k", 10, 60);

    expect(first).toEqual({ allowed: true, limit: 10, remaining: 9, resetSeconds: 45 });
  });

  it("slides: the previous window still counts, fading out as time passes", async () => {
    await hits(10); // a full window

    now += 60_000; // start of the next window: the previous one still counts in full
    expect((await limiter.hit("k", 10, 60)).allowed).toBe(false);

    now += 30_000; // halfway: the previous window counts for half, 5 of 10
    expect(await hits(6)).toEqual([true, true, true, true, true, false]);
  });

  it("forgets everything after two windows", async () => {
    await hits(10);
    now += 120_000;

    expect(await hits(10)).toEqual(Array(10).fill(true));
  });

  it("can't be beaten by sending everything at once", async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () => limiter.hit("burst", 10, 60)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("keys are independent", async () => {
    await hits(10);

    expect((await limiter.hit("other", 10, 60)).allowed).toBe(true);
  });

  it("fails open when Redis is down", async () => {
    const dead = new Redis("redis://127.0.0.1:1/0", {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
    });
    dead.on("error", () => undefined);

    const result = await new RateLimiter(dead, logger).hit("k", 10, 60);
    dead.disconnect();

    expect(result.allowed).toBe(true);
  });
});
