import type { Connection } from "mongoose";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Models } from "../models/index.js";
import type { Gateways } from "../payments/checkout.js";
import type { RateLimiter } from "../ratelimit.js";

export type RouteDeps = {
  config: Config;
  logger: Logger;
  mongo: Connection;
  models: Models;
  rateLimiter: RateLimiter;
  /** Razorpay clients per mode (null when that mode has no keys). */
  gateways: Gateways;
};
