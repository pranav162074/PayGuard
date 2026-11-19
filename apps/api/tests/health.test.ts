import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { CheckFailure, runChecks } from "../src/health.js";
import { createLogger } from "../src/logger.js";
import { createRedis } from "../src/redis.js";
import { startTestApp, type TestApp } from "./helpers.js";

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.close();
  testApp = undefined;
});

describe("health", () => {
  it("liveness needs no dependencies", async () => {
    testApp = await startTestApp();

    const res = await request(testApp.app).get("/health/live");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("is ready when MongoDB and Redis answer", async () => {
    testApp = await startTestApp();

    const res = await request(testApp.app).get("/health/ready");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.mongo.status).toBe("up");
    expect(res.body.checks.redis.status).toBe("up");
  });

  it("is not ready when Redis is down, and says nothing about the connection", async () => {
    testApp = await startTestApp();
    // A Redis client pointed at a port nothing listens on
    const errors: Error[] = [];
    const deadRedis = createRedis("redis://127.0.0.1:1/0", (err) => errors.push(err));
    const app = createApp({ ...testApp, logger: createLogger("silent"), redis: deadRedis });

    const res = await request(app).get("/health/ready");
    deadRedis.disconnect();

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unavailable");
    expect(res.body.checks.mongo.status).toBe("up");
    expect(res.body.checks.redis).toMatchObject({ status: "down", error: "unavailable" });
    expect(JSON.stringify(res.body)).not.toMatch(/127\.0\.0\.1|ECONNREFUSED/);
    // The connection failure went to the error handler (the logger, in the real app)
    expect(errors.length).toBeGreaterThan(0);
  });

  it("is not ready when MongoDB is disconnected", async () => {
    testApp = await startTestApp();
    await testApp.mongo.close();

    const res = await request(testApp.app).get("/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.checks.mongo.status).toBe("down");
    expect(res.body.checks.redis.status).toBe("up");
  });
});

describe("runChecks", () => {
  it("times out a check that hangs, without waiting for it", async () => {
    const started = Date.now();

    const result = await runChecks(
      {
        hangs: () => new Promise(() => undefined),
        fine: () => Promise.resolve(),
      },
      100,
    );

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.ready).toBe(false);
    expect(result.checks.hangs).toMatchObject({ status: "down", error: "timeout" });
    expect(result.checks.fine?.status).toBe("up");
  });

  it("reports safe failure reasons, and hides other errors", async () => {
    const result = await runChecks(
      {
        standalone: () => Promise.reject(new CheckFailure("not_replica_set")),
        crashed: () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.5:27017")),
      },
      1000,
    );

    expect(result.checks.standalone?.error).toBe("not_replica_set");
    expect(result.checks.crashed?.error).toBe("unavailable");
  });

  it("runs checks in parallel", async () => {
    const wait = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
    const started = Date.now();

    await runChecks({ a: wait, b: wait, c: wait }, 1000);

    expect(Date.now() - started).toBeLessThan(500);
  });
});
