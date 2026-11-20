import type { Redis } from "ioredis";

import type { Logger } from "./logger.js";

/**
 * Sliding-window rate limiting, approximated with two fixed windows: the estimate is the
 * current window's count plus the previous window's count weighted by how much of it still
 * overlaps the sliding window. Unlike a plain fixed window, a client can't fit twice the
 * limit into a short burst across a window boundary.
 *
 * Runs as one Lua script, so concurrent requests can't both slip under the limit. The key is
 * wrapped in {braces} so both windows land on the same node if Redis is ever clustered.
 */
const SCRIPT = `
local window = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local current_start = now - (now % window)
local current_key = KEYS[1] .. ":" .. current_start
local previous_key = KEYS[1] .. ":" .. (current_start - window)
local previous = tonumber(redis.call("GET", previous_key) or "0")
local current = tonumber(redis.call("GET", current_key) or "0")
local weight = (window - (now - current_start)) / window
if previous * weight + current + 1 > limit then
  return {0, math.ceil(previous * weight + current)}
end
current = redis.call("INCR", current_key)
if current == 1 then
  redis.call("PEXPIRE", current_key, window * 2)
end
return {1, math.ceil(previous * weight + current)}
`;

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window ends (when the count starts dropping). */
  resetSeconds: number;
};

export class RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const windowMs = windowSeconds * 1000;
    const now = this.now();
    const resetSeconds = Math.max(1, Math.ceil((windowMs - (now % windowMs)) / 1000));
    try {
      const [allowed, used] = (await this.redis.eval(
        SCRIPT,
        1,
        `ratelimit:{${key}}`,
        windowMs,
        now,
        limit,
      )) as [number, number];
      return {
        allowed: allowed === 1,
        limit,
        remaining: Math.max(0, limit - used),
        resetSeconds,
      };
    } catch (err) {
      // Fail open: a Redis outage shouldn't take the whole API down with it
      this.logger.warn({ err, key }, "Rate limiter unavailable, allowing request");
      return { allowed: true, limit, remaining: limit, resetSeconds };
    }
  }
}
