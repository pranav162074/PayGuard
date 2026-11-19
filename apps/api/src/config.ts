import { z } from "zod";

const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  MONGO_URL: z
    .url({ protocol: /^mongodb(\+srv)?$/, error: "Must be a mongodb:// or mongodb+srv:// URL" })
    .default("mongodb://localhost:27018/payguard?replicaSet=rs0&directConnection=true"),
  REDIS_URL: z
    .url({ protocol: /^rediss?$/, error: "Must be a redis:// or rediss:// URL" })
    .default("redis://localhost:6381/0"),
  // A readiness check slower than this counts as down
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  JSON_BODY_LIMIT: z
    .string()
    .regex(/^\d+(b|kb|mb)$/)
    .default("100kb"),
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: (typeof LOG_LEVELS)[number];
  mongoUrl: string;
  redisUrl: string;
  healthCheckTimeoutMs: number;
  jsonBodyLimit: string;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Reads configuration from environment variables. Fails fast, listing every bad value. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty values count as unset, so `PORT=` in .env falls back to the default
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = schema.safeParse(present);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new ConfigError(`Invalid configuration:\n  ${problems.join("\n  ")}`);
  }
  const c = result.data;
  return {
    nodeEnv: c.NODE_ENV,
    port: c.PORT,
    logLevel: c.LOG_LEVEL,
    mongoUrl: c.MONGO_URL,
    redisUrl: c.REDIS_URL,
    healthCheckTimeoutMs: c.HEALTH_CHECK_TIMEOUT_MS,
    jsonBodyLimit: c.JSON_BODY_LIMIT,
  };
}
