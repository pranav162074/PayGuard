import express, { type Express } from "express";
import helmet from "helmet";
import type { Redis } from "ioredis";
import type { Connection } from "mongoose";
import { pinoHttp } from "pino-http";

import type { Config } from "./config.js";
import { mongoCheck, redisCheck } from "./health.js";
import type { Logger } from "./logger.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { requestId } from "./middleware/requestId.js";
import { healthRouter } from "./routes/health.js";

export type AppDeps = {
  config: Config;
  logger: Logger;
  mongo: Connection;
  redis: Redis;
};

export function createApp({ config, logger, mongo, redis }: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");

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
  app.use(express.json({ limit: config.jsonBodyLimit }));

  app.use(
    healthRouter(
      { mongo: mongoCheck(mongo), redis: redisCheck(redis) },
      config.healthCheckTimeoutMs,
    ),
  );

  app.use(notFound);
  app.use(errorHandler(logger));
  return app;
}
