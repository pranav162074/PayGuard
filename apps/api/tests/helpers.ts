import { Writable } from "node:stream";

import type { Redis } from "ioredis";
import request from "supertest";
import type { Connection } from "mongoose";

import { createApp, ensureIndexes, type App } from "../src/app.js";
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
  app: App;
  config: Config;
  mongo: Connection;
  redis: Redis;
  close: () => Promise<void>;
};

export async function startTestApp(
  options: { config?: Partial<Config>; logger?: Logger; now?: () => number } = {},
): Promise<TestApp> {
  const config = testConfig(options.config);
  const mongo = await connectMongo(config.mongoUrl);
  await mongo.dropDatabase();
  const redis = createRedis(config.redisUrl, () => undefined);
  await redis.connect();
  await redis.flushdb();
  const logger = options.logger ?? createLogger("silent");
  const app = createApp({ config, logger, mongo, redis, now: options.now });
  await ensureIndexes(app.locals.models);
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

export type Session = {
  accessToken: string;
  /** The refresh cookie, ready to send back as a Cookie header. */
  cookie: string;
  userId: string;
  merchantId: string;
};

export function refreshCookieFrom(res: { headers: Record<string, unknown> }): string {
  const setCookie = res.headers["set-cookie"] as string[] | undefined;
  const cookie = setCookie?.find((c) => c.startsWith("pg_refresh="));
  if (!cookie) throw new Error("No refresh cookie in the response");
  return cookie.split(";")[0] as string;
}

let counter = 0;

export async function signup(
  app: App,
  fields: Partial<{ email: string; password: string; name: string; businessName: string }> = {},
): Promise<Session & { email: string; password: string }> {
  counter += 1;
  const body = {
    email: `owner${counter}@example.com`,
    password: "correct horse battery",
    name: "Owner",
    businessName: `Shop ${counter}`,
    ...fields,
  };
  const res = await request(app).post("/v1/auth/signup").send(body);
  if (res.status !== 201) throw new Error(`Signup failed: ${res.status} ${res.text}`);
  return {
    accessToken: res.body.accessToken as string,
    cookie: refreshCookieFrom(res),
    userId: res.body.user.id as string,
    merchantId: res.body.merchant.id as string,
    email: body.email,
    password: body.password,
  };
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

/** Invites someone with a role and has them accept as a new user; returns their session. */
export async function addMember(
  app: App,
  owner: Session,
  role: "owner" | "developer" | "analyst",
): Promise<Session & { email: string; password: string }> {
  counter += 1;
  const email = `member${counter}@example.com`;
  const password = "member password 123";
  const invited = await request(app)
    .post("/v1/team/invitations")
    .set(bearer(owner.accessToken))
    .send({ email, role });
  if (invited.status !== 201) throw new Error(`Invite failed: ${invited.text}`);
  const accepted = await request(app)
    .post("/v1/auth/accept-invitation")
    .send({ token: invited.body.token, password, name: "Member" });
  if (accepted.status !== 201) throw new Error(`Accept failed: ${accepted.text}`);
  return {
    accessToken: accepted.body.accessToken as string,
    cookie: refreshCookieFrom(accepted),
    userId: accepted.body.user.id as string,
    merchantId: accepted.body.merchant.id as string,
    email,
    password,
  };
}
