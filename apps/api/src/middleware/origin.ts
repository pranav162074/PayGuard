import type { RequestHandler } from "express";

import { ApiError } from "../errors.js";

/**
 * Cookie-authenticated endpoints (refresh, logout) check where a browser request came from.
 * The cookie is SameSite=Strict already; this is the second layer against cross-site request
 * forgery. Requests without an Origin header (curl, servers) aren't from a browser page.
 */
export function allowedOrigins(origins: readonly string[]): RequestHandler {
  const allowed = new Set(origins);
  return (req, _res, next) => {
    const origin = req.get("origin");
    if (origin && !allowed.has(origin)) {
      throw new ApiError(403, "forbidden_origin", "Requests from this origin are not allowed");
    }
    next();
  };
}
