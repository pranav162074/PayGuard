import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Redis } from "ioredis";
import type { Connection } from "mongoose";
import { pinoHttp } from "pino-http";

import type { Config } from "./config.js";
import { mongoCheck, redisCheck } from "./health.js";
import type { Logger } from "./logger.js";
import type { Fetch } from "./gateway/razorpay.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { requestId } from "./middleware/requestId.js";
import { ensureIndexes, registerModels, type Models } from "./models/index.js";
import { createGateways } from "./payments/checkout.js";
import { RateLimiter } from "./ratelimit.js";
import { apiKeysRouter } from "./routes/apiKeys.js";
import { authRouter } from "./routes/auth.js";
import { checkoutRouter } from "./routes/checkout.js";
import type { RouteDeps } from "./routes/deps.js";
import { healthRouter } from "./routes/health.js";
import { ledgerRouter } from "./routes/ledger.js";
import { meRouter } from "./routes/me.js";
import { paymentsRouter } from "./routes/payments.js";
import { teamRouter } from "./routes/team.js";
import { webhookEndpointsRouter } from "./routes/webhookEndpoints.js";
import { webhooksRouter } from "./routes/webhooks.js";
import type { WebhookDeps } from "./webhooks/delivery.js";
import { createWebhookQueue } from "./webhooks/queue.js";
import { createWebhookAgent, systemLookup, type Lookup } from "./webhooks/ssrf.js";

export type AppDeps = {
  config: Config;
  logger: Logger;
  mongo: Connection;
  redis: Redis;
  /** The clock rate limits use; tests move it forward instead of waiting. */
  now?: () => number;
  /** How the app reaches Razorpay; tests pass a fake. */
  razorpayFetch?: Fetch;
  /** DNS for webhook URLs; tests pass a fake to play private and rebinding hosts. */
  webhookLookup?: Lookup;
};

export type App = Express & {
  locals: { models: Models; webhooks: WebhookDeps & { close: () => Promise<void> } };
};

export { ensureIndexes };

export function createApp({
  config,
  logger,
  mongo,
  redis,
  now,
  razorpayFetch,
  webhookLookup = systemLookup,
}: AppDeps): App {
  const app = express() as App;
  app.disable("x-powered-by");
  // Behind a proxy, take the client IP from X-Forwarded-For, trusting only that many hops
  app.set("trust proxy", config.trustProxyHops);

  const models = registerModels(mongo);
  app.locals.models = models;
  const webhookQueue = createWebhookQueue(config);
  const agent = createWebhookAgent({
    allowPrivate: config.webhooks.allowPrivateUrls,
    lookup: webhookLookup,
    timeoutMs: config.webhooks.timeoutMs,
  });
  const webhooks: WebhookDeps = { config, logger, models, queue: webhookQueue, agent };
  app.locals.webhooks = {
    ...webhooks,
    close: async () => {
      await webhookQueue.close();
      await agent.close();
    },
  };
  const deps: RouteDeps = {
    config,
    logger,
    mongo,
    models,
    rateLimiter: new RateLimiter(redis, logger, now),
    gateways: createGateways(config, razorpayFetch),
    webhooks,
    lookup: webhookLookup,
  };

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      // Health probes run every few seconds; logging them would drown everything else
      autoLogging: { ignore: (req) => req.url.startsWith("/health") },
      // One compact line per request; requestId comes from the logger's mixin
      serializers: {
        req: (req: express.Request) => ({ method: req.method, url: req.url }),
        res: (res: express.Response) => ({ statusCode: res.statusCode }),
      },
      customLogLevel: (_req, res, err) =>
        err || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
    }),
  );
  app.use(helmet());
  // Only the dashboard's origins may call the API from a browser, with cookies
  app.use(cors({ origin: config.corsOrigins, credentials: true }));
  // Before the JSON parser: webhook signatures cover the raw bytes
  app.use(webhooksRouter(deps));
  app.use(express.json({ limit: config.jsonBodyLimit }));
  app.use(cookieParser());

  app.use(
    healthRouter(
      { mongo: mongoCheck(mongo), redis: redisCheck(redis) },
      config.healthCheckTimeoutMs,
    ),
  );

  app.use(authRouter(deps));
  app.use(meRouter(deps));
  app.use(teamRouter(deps));
  app.use(apiKeysRouter(deps));
  app.use(ledgerRouter(deps));
  app.use(paymentsRouter(deps));
  app.use(checkoutRouter(deps));
  app.use(webhookEndpointsRouter(deps));

  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}
