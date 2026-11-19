import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("has working defaults for local development", () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      nodeEnv: "development",
      port: 4000,
      mongoUrl: "mongodb://localhost:27018/payguard?replicaSet=rs0&directConnection=true",
      redisUrl: "redis://localhost:6381/0",
    });
  });

  it("reads and converts environment variables", () => {
    const config = loadConfig({ PORT: "8080", HEALTH_CHECK_TIMEOUT_MS: "500", LOG_LEVEL: "debug" });

    expect(config.port).toBe(8080);
    expect(config.healthCheckTimeoutMs).toBe(500);
    expect(config.logLevel).toBe("debug");
  });

  it("treats empty values as unset", () => {
    expect(loadConfig({ PORT: "" }).port).toBe(4000);
  });

  it("lists every invalid value at once", () => {
    const load = () =>
      loadConfig({ PORT: "99999", MONGO_URL: "http://localhost", REDIS_URL: "nope" });

    expect(load).toThrow(ConfigError);
    expect(load).toThrow(/PORT/);
    expect(load).toThrow(/MONGO_URL: Must be a mongodb/);
    expect(load).toThrow(/REDIS_URL/);
  });
});
