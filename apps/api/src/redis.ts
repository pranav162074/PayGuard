import { Redis } from "ioredis";

/** The app's Redis client for caching and rate limits. Queues (BullMQ) get their own later. */
export function createRedis(url: string, onError: (err: Error) => void): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    // Commands fail quickly while Redis is down, instead of waiting in an offline queue
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  // ioredis reports connection problems as "error" events and keeps reconnecting on its own.
  // Without a listener they print as unhandled errors, so route them to the logger.
  redis.on("error", onError);
  return redis;
}
