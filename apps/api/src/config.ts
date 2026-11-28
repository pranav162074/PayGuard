import { z } from "zod";

// Only for local development and tests; refused in production (see loadConfig)
const DEV_JWT_SECRET = "dev-only-secret-do-not-use-in-production-0000";
// 32 zero bytes, base64url: encrypts webhook signing secrets in development and tests only
const DEV_WEBHOOK_SECRETS_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const flag = z.enum(["true", "false"]).transform((value) => value === "true");

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

  // Our processing fee, in basis points (200 = 2%)
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(1000).default(200),

  // Razorpay, the gateway customers actually pay through. Test-mode payment intents use the
  // test keys, live ones the live keys. A mode without keys can't take payments.
  RAZORPAY_TEST_KEY_ID: z
    .string()
    .regex(/^rzp_test_\w+$/, "Must start with rzp_test_")
    .optional(),
  RAZORPAY_TEST_KEY_SECRET: z.string().min(8).optional(),
  RAZORPAY_LIVE_KEY_ID: z
    .string()
    .regex(/^rzp_live_\w+$/, "Must start with rzp_live_")
    .optional(),
  RAZORPAY_LIVE_KEY_SECRET: z.string().min(8).optional(),
  // Set in the Razorpay dashboard when adding the webhook; signs every webhook body
  RAZORPAY_WEBHOOK_SECRET: z.string().min(8).optional(),
  RAZORPAY_API_URL: z.url({ protocol: /^https?$/ }).default("https://api.razorpay.com/v1"),
  // Where the hosted checkout app (apps/checkout) is served, for the checkout links we give
  // merchants
  CHECKOUT_URL: z.url({ protocol: /^https?$/ }).default("http://localhost:5174"),
  // How often to ask Razorpay about payments whose webhook hasn't arrived (0 turns it off),
  // and how old an unfinished payment must be before we ask
  RECONCILE_INTERVAL_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  RECONCILE_AFTER_SECONDS: z.coerce.number().int().min(10).max(86_400).default(120),

  // Webhooks to merchants. Signing secrets are stored encrypted with this key (32 random
  // bytes, base64url: `node -e "console.log(crypto.randomBytes(32).toString('base64url'))"`)
  WEBHOOK_SECRETS_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, "Must be 32 bytes, base64url-encoded (43 characters)")
    .default(DEV_WEBHOOK_SECRETS_KEY),
  // Lets webhook URLs point at private addresses (localhost, 10.x, ...). Development only:
  // in production they are how SSRF reaches internal services
  WEBHOOK_ALLOW_PRIVATE_URLS: flag.default(false),
  // Attempts per delivery before it goes to the dead-letter queue, and the backoff between
  // them: random in [0, min(max, base × 2^attempt)] ("full jitter")
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().min(1).default(30_000),
  WEBHOOK_RETRY_MAX_MS: z.coerce
    .number()
    .int()
    .min(1)
    .default(6 * 60 * 60 * 1000),
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(10_000),
  WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  // How often new events are turned into deliveries (0 turns delivery off in this process)
  WEBHOOK_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(1000),

  // Nightly reconciliation of the previous day (India time), as a cron pattern; blank turns
  // it off. 06:00 IST: Razorpay's settlement report for the day before is ready by then.
  RECONCILIATION_CRON: z.string().default("0 6 * * *"),
  RECONCILIATION_TIMEZONE: z.string().default("Asia/Kolkata"),
  // Live payments still unsettled after this many days are flagged
  SETTLEMENT_OVERDUE_DAYS: z.coerce.number().int().min(1).max(30).default(3),
});

export type GatewayKeys = { keyId: string; keySecret: string };

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
  platformFeeBps: number;
  razorpay: {
    /** Keys per mode; null when that mode can't take payments. */
    test: GatewayKeys | null;
    live: GatewayKeys | null;
    webhookSecret: string | null;
    apiUrl: string;
  };
  checkoutUrl: string;
  reconcile: { intervalSeconds: number; afterSeconds: number };
  reconciliation: { cron: string | null; timezone: string; overdueDays: number };
  webhooks: {
    secretsKey: string;
    allowPrivateUrls: boolean;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
    timeoutMs: number;
    concurrency: number;
    dispatchIntervalMs: number;
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
  if (c.NODE_ENV === "production" && c.WEBHOOK_SECRETS_KEY === DEV_WEBHOOK_SECRETS_KEY) {
    throw new ConfigError(
      "Invalid configuration:\n  WEBHOOK_SECRETS_KEY: Set a real key in production",
    );
  }
  if (c.NODE_ENV === "production" && c.WEBHOOK_ALLOW_PRIVATE_URLS) {
    throw new ConfigError(
      "Invalid configuration:\n  WEBHOOK_ALLOW_PRIVATE_URLS: Not allowed in production",
    );
  }
  const keyPairs = [
    [
      "RAZORPAY_TEST_KEY_ID",
      c.RAZORPAY_TEST_KEY_ID,
      "RAZORPAY_TEST_KEY_SECRET",
      c.RAZORPAY_TEST_KEY_SECRET,
    ],
    [
      "RAZORPAY_LIVE_KEY_ID",
      c.RAZORPAY_LIVE_KEY_ID,
      "RAZORPAY_LIVE_KEY_SECRET",
      c.RAZORPAY_LIVE_KEY_SECRET,
    ],
  ] as const;
  for (const [idName, id, secretName, secret] of keyPairs) {
    if (Boolean(id) !== Boolean(secret)) {
      throw new ConfigError(
        `Invalid configuration:\n  ${idName} and ${secretName} must be set together`,
      );
    }
  }
  if (c.RAZORPAY_LIVE_KEY_ID && !c.RAZORPAY_WEBHOOK_SECRET) {
    // Without webhooks, a live payment whose customer closes the tab is only noticed by the
    // reconciler; with real money that delay isn't acceptable
    throw new ConfigError(
      "Invalid configuration:\n  RAZORPAY_WEBHOOK_SECRET: Required when live keys are set",
    );
  }
  const keys = (keyId?: string, keySecret?: string): GatewayKeys | null =>
    keyId && keySecret ? { keyId, keySecret } : null;
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
    platformFeeBps: c.PLATFORM_FEE_BPS,
    razorpay: {
      test: keys(c.RAZORPAY_TEST_KEY_ID, c.RAZORPAY_TEST_KEY_SECRET),
      live: keys(c.RAZORPAY_LIVE_KEY_ID, c.RAZORPAY_LIVE_KEY_SECRET),
      webhookSecret: c.RAZORPAY_WEBHOOK_SECRET ?? null,
      apiUrl: c.RAZORPAY_API_URL.replace(/\/+$/, ""),
    },
    checkoutUrl: c.CHECKOUT_URL.replace(/\/+$/, ""),
    reconcile: {
      intervalSeconds: c.RECONCILE_INTERVAL_SECONDS,
      afterSeconds: c.RECONCILE_AFTER_SECONDS,
    },
    reconciliation: {
      cron: c.RECONCILIATION_CRON.trim() || null,
      timezone: c.RECONCILIATION_TIMEZONE,
      overdueDays: c.SETTLEMENT_OVERDUE_DAYS,
    },
    webhooks: {
      secretsKey: c.WEBHOOK_SECRETS_KEY,
      allowPrivateUrls: c.WEBHOOK_ALLOW_PRIVATE_URLS,
      maxAttempts: c.WEBHOOK_MAX_ATTEMPTS,
      retryBaseMs: c.WEBHOOK_RETRY_BASE_MS,
      retryMaxMs: c.WEBHOOK_RETRY_MAX_MS,
      timeoutMs: c.WEBHOOK_TIMEOUT_MS,
      concurrency: c.WEBHOOK_CONCURRENCY,
      dispatchIntervalMs: c.WEBHOOK_DISPATCH_INTERVAL_MS,
    },
    secureCookies: c.NODE_ENV === "production",
  };
}
