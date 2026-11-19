import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connectMongo } from "./db.js";
import { createLogger } from "./logger.js";
import { createRedis } from "./redis.js";

const SHUTDOWN_GRACE_MS = 10_000;

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
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.nodeEnv }, "PayGuard API listening");
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Shutting down");
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
