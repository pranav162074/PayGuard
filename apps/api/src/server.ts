import { createApp, ensureIndexes } from "./app.js";
import { loadConfig } from "./config.js";
import { connectMongo } from "./db.js";
import { createLogger, type Logger } from "./logger.js";
import { createGateways, reconcile, type CheckoutDeps } from "./payments/checkout.js";
import { reconcileRefunds } from "./payments/refunds.js";
import { createRedis } from "./redis.js";

const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Every interval, asks Razorpay about payments and refunds whose webhook hasn't arrived. Runs one pass
 * at a time (the next is scheduled only when the previous finishes). With several server
 * instances each would run it; that's safe, since every update it makes is conditional and
 * idempotent, just redundant. Returns a function that stops it.
 */
function startReconciler(
  deps: CheckoutDeps,
  logger: Logger,
  intervalSeconds: number,
  afterSeconds: number,
): () => void {
  if (intervalSeconds === 0 || (!deps.gateways.test && !deps.gateways.live)) return () => undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async () => {
    try {
      const result = await reconcile(deps, { afterSeconds });
      if (result.checked > 0) logger.info(result, "Reconciled payments with Razorpay");
      const refunds = await reconcileRefunds(deps, { afterSeconds });
      if (refunds.checked > 0) logger.info(refunds, "Reconciled refunds with Razorpay");
    } catch (err) {
      logger.error({ err }, "Reconciliation pass failed");
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalSeconds * 1000).unref();
  };
  timer = setTimeout(() => void tick(), intervalSeconds * 1000).unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile(); // .env, if there is one
  } catch {
    // No .env file: use the real environment
  }
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  const mongo = await connectMongo(config.mongoUrl);
  const redis = createRedis(config.redisUrl, (err) => {
    logger.warn({ err }, "Redis connection error");
  });
  await redis.connect();

  const app = createApp({ config, logger, mongo, redis });
  // Unique indexes enforce rules like "one account per email", so they must exist first
  await ensureIndexes(app.locals.models);
  const stopReconciler = startReconciler(
    {
      mongo,
      models: app.locals.models,
      feeBasisPoints: config.platformFeeBps,
      gateways: createGateways(config),
      logger,
    },
    logger,
    config.reconcile.intervalSeconds,
    config.reconcile.afterSeconds,
  );
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, "PayGuard API listening");
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
    stopReconciler();
    // Stop taking new connections, let in-flight requests finish, then close the databases
    const force = setTimeout(() => {
      logger.error("Requests still running after the grace period, exiting anyway");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    server.close(() => {
      void Promise.allSettled([mongo.close(), redis.quit()]).then(() => {
        logger.info("Shutdown complete");
        process.exit(0);
      });
    });
    server.closeIdleConnections();
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "Unhandled promise rejection");
    process.exit(1);
  });
}

main().catch((err: unknown) => {
  // The logger may not exist yet (bad config), so plain stderr
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
