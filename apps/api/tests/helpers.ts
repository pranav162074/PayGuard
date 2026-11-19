import { Writable } from "node:stream";

import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Connection } from "mongoose";

import { createApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { connectMongo } from "../src/db.js";
import { createLogger, type Logger } from "../src/logger.js";
import { createRedis } from "../src/redis.js";

/**
 * Tests use their own database (payguard_test) and Redis database 15, on the same servers as
 * development, so running the tests never touches development data.
 */
export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({ ...process.env, NODE_ENV: "test", LOG_LEVEL: "silent" });
  const mongoUrl = new URL(base.mongoUrl);
  mongoUrl.pathname = "/payguard_test";
  const redisUrl = new URL(base.redisUrl);
  redisUrl.pathname = "/15";
  return { ...base, mongoUrl: mongoUrl.toString(), redisUrl: redisUrl.toString(), ...overrides };
}

/** A logger that keeps its lines in memory, so tests can read what was logged. */
export function memoryLogger(): { logger: Logger; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      chunks.push(chunk.toString());
      done();
    },
  });
  return {
    logger: createLogger("info", stream),
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

export type TestApp = {
  app: Express;
  config: Config;
  mongo: Connection;
  redis: Redis;
  close: () => Promise<void>;
};

export async function startTestApp(
  options: { config?: Partial<Config>; logger?: Logger } = {},
): Promise<TestApp> {
  const config = testConfig(options.config);
  const mongo = await connectMongo(config.mongoUrl);
  await mongo.dropDatabase();
  const redis = createRedis(config.redisUrl, () => undefined);
  await redis.connect();
  await redis.flushdb();
  const logger = options.logger ?? createLogger("silent");
  const app = createApp({ config, logger, mongo, redis });
  return {
    app,
    config,
    mongo,
    redis,
    close: async () => {
      await mongo.close();
      redis.disconnect();
    },
  };
}
