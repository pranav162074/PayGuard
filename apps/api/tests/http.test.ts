import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";

import { requestContext } from "../src/context.js";
import { errorHandler } from "../src/middleware/errors.js";
import { requestId } from "../src/middleware/requestId.js";
import { memoryLogger, startTestApp, type TestApp } from "./helpers.js";

let testApp: TestApp | undefined;

afterEach(async () => {
  await testApp?.close();
  testApp = undefined;
});

describe("request IDs", () => {
  it("generates one when the caller sends none", async () => {
    testApp = await startTestApp();

    const res = await request(testApp.app).get("/health/live");

    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("keeps a safe ID from the caller", async () => {
    testApp = await startTestApp();

    const res = await request(testApp.app).get("/health/live").set("X-Request-ID", "trace-123.a_b");

    expect(res.headers["x-request-id"]).toBe("trace-123.a_b");
  });

  it.each([
    ["too long", "a".repeat(65)],
    ["log injection", 'abc"}\n{"level":"fatal'],
    ["spaces", "has spaces"],
  ])("replaces an unsafe ID (%s)", async (_, unsafe) => {
    testApp = await startTestApp();

    const res = await request(testApp.app)
      .get("/health/live")
      .set("X-Request-ID", encodeURI(unsafe));

    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is on every log line written during the request, even after an await", async () => {
    const { logger, lines } = memoryLogger();
    const app = express();
    app.use(requestId);
    app.get("/work", async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      logger.info("did some work");
      res.json({ requestId: requestContext.getStore()?.requestId });
    });

    const res = await request(app).get("/work").set("X-Request-ID", "req-42");

    expect(res.body).toEqual({ requestId: "req-42" });
    expect(lines()).toContainEqual(
      expect.objectContaining({ msg: "did some work", requestId: "req-42" }),
    );
  });
});

describe("errors", () => {
  it("unknown routes get the standard error shape", async () => {
    testApp = await startTestApp();

    const res = await request(testApp.app).get("/v1/nothing");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "not_found", message: "No route for GET /v1/nothing" },
    });
  });

  it("malformed JSON is a 400, not a crash", async () => {
    testApp = await startTestApp();

    const res = await request(testApp.app)
      .post("/v1/anything")
      .set("Content-Type", "application/json")
      .send('{"amount": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_json");
  });

  it("bodies over the limit are rejected", async () => {
    testApp = await startTestApp({ config: { jsonBodyLimit: "1kb" } });

    const res = await request(testApp.app)
      .post("/v1/anything")
      .send({ note: "x".repeat(2000) });

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });

  it("unexpected errors are logged in full but hidden from the client", async () => {
    const { logger, lines } = memoryLogger();
    const app = express();
    app.use(requestId);
    app.get("/boom", () => {
      throw new Error("password=hunter2 leaked in a stack trace");
    });
    app.use(errorHandler(logger));

    const res = await request(app).get("/boom");

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
    expect(JSON.stringify(res.body)).not.toContain("hunter2");
    const logged = lines().find((line) => line.msg === "Unhandled error");
    expect(logged).toMatchObject({ level: "error", requestId: res.headers["x-request-id"] });
  });

  it("async errors are caught too (Express 5)", async () => {
    const { logger } = memoryLogger();
    const app = express();
    app.get("/async-boom", async () => {
      await Promise.resolve();
      throw new Error("async failure");
    });
    app.use(errorHandler(logger));

    const res = await request(app).get("/async-boom");

    expect(res.status).toBe(500);
  });
});

describe("security headers", () => {
  it("sets helmet's headers and hides the framework", async () => {
    testApp = await startTestApp();

    const res = await request(testApp.app).get("/health/live");

    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
