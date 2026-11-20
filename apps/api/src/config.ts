import { z } from "zod";

// Only for local development and tests; refused in production (see loadConfig)
const DEV_JWT_SECRET = "dev-only-secret-do-not-use-in-production-0000";

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

  // Signs access tokens. Must be a long random secret outside development and tests.
  JWT_SECRET: z.string().min(32).default(DEV_JWT_SECRET),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  // Browser origins allowed to call the API with cookies (the dashboard), comma-separated
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  // Number of proxies in front of the app (for the client IP used by rate limits)
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  // Rate limits (requests per window)
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(100),
  LOGIN_LIMIT_PER_IP: z.coerce.number().int().positive().default(30),
  LOGIN_LIMIT_PER_EMAIL: z.coerce.number().int().positive().default(10),
  SIGNUP_LIMIT_PER_IP: z.coerce.number().int().positive().default(5),
});

export type Config = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: (typeof LOG_LEVELS)[number];
  mongoUrl: string;
  redisUrl: string;
  healthCheckTimeoutMs: number;
  jsonBodyLimit: string;
  jwtSecret: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  corsOrigins: string[];
  trustProxyHops: number;
  rateLimits: {
    apiPerMinute: number;
    loginPerIp: number;
    loginPerEmail: number;
    signupPerIp: number;
  };
  /** Refresh-token cookies are Secure (HTTPS only) everywhere except local development and tests. */
  secureCookies: boolean;
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
  if (c.NODE_ENV === "production" && c.JWT_SECRET === DEV_JWT_SECRET) {
    throw new ConfigError("Invalid configuration:\n  JWT_SECRET: Set a real secret in production");
  }
  return {
    nodeEnv: c.NODE_ENV,
    port: c.PORT,
    logLevel: c.LOG_LEVEL,
    mongoUrl: c.MONGO_URL,
    redisUrl: c.REDIS_URL,
    healthCheckTimeoutMs: c.HEALTH_CHECK_TIMEOUT_MS,
    jsonBodyLimit: c.JSON_BODY_LIMIT,
    jwtSecret: c.JWT_SECRET,
    accessTokenTtlSeconds: c.ACCESS_TOKEN_TTL_SECONDS,
    refreshTokenTtlDays: c.REFRESH_TOKEN_TTL_DAYS,
    corsOrigins: c.CORS_ORIGINS,
    trustProxyHops: c.TRUST_PROXY_HOPS,
    rateLimits: {
      apiPerMinute: c.API_RATE_LIMIT_PER_MINUTE,
      loginPerIp: c.LOGIN_LIMIT_PER_IP,
      loginPerEmail: c.LOGIN_LIMIT_PER_EMAIL,
      signupPerIp: c.SIGNUP_LIMIT_PER_IP,
    },
    secureCookies: c.NODE_ENV === "production",
  };
}
