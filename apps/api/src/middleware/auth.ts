import type { Request, RequestHandler, Response } from "express";
import { isValidObjectId } from "mongoose";

import { API_KEY_PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "../auth/permissions.js";
import { InvalidToken, parseApiKey, sha256, verifyAccessToken } from "../auth/tokens.js";
import type { Config } from "../config.js";
import { ApiError } from "../errors.js";
import type { KeyMode, Models, Role } from "../models/index.js";
import type { RateLimiter, RateLimitResult } from "../ratelimit.js";

export type UserPrincipal = {
  kind: "user";
  userId: string;
  merchantId: string;
  role: Role;
  sessionId: string;
  permissions: ReadonlySet<Permission>;
};

export type ApiKeyPrincipal = {
  kind: "api_key";
  keyId: string;
  merchantId: string;
  mode: KeyMode;
  permissions: ReadonlySet<Permission>;
};

export type Principal = UserPrincipal | ApiKeyPrincipal;

declare module "express-serve-static-core" {
  interface Request {
    principal?: Principal;
  }
}

// Writing lastUsedAt on every request would turn every read into a write
const LAST_USED_RESOLUTION_MS = 60_000;

function unauthorized(message = "Missing or invalid credentials"): ApiError {
  return new ApiError(401, "unauthorized", message);
}

export function setRateLimitHeaders(res: Response, result: RateLimitResult): void {
  res.setHeader("RateLimit-Limit", result.limit);
  res.setHeader("RateLimit-Remaining", result.remaining);
  res.setHeader("RateLimit-Reset", result.resetSeconds);
}

export function enforce(res: Response, result: RateLimitResult): void {
  setRateLimitHeaders(res, result);
  if (!result.allowed) {
    res.setHeader("Retry-After", result.resetSeconds);
    throw new ApiError(429, "rate_limited", "Too many requests. Try again shortly.");
  }
}

type AuthDeps = { config: Config; models: Models; rateLimiter: RateLimiter };

/**
 * Accepts either a dashboard access token (a JWT) or a secret API key, both as
 * `Authorization: Bearer ...`, and attaches who is calling as req.principal.
 */
export function authenticate({ config, models, rateLimiter }: AuthDeps): RequestHandler {
  return async (req, res, next) => {
    const header = req.get("authorization") ?? "";
    const [scheme, credential] = header.split(" ");
    if (scheme !== "Bearer" || !credential) {
      res.setHeader("WWW-Authenticate", "Bearer");
      throw unauthorized();
    }

    let principal: Principal;
    if (credential.startsWith("sk_")) {
      if (!parseApiKey(credential)) throw unauthorized();
      const key = await models.ApiKey.findOne({ keyHash: sha256(credential), revokedAt: null });
      if (!key) throw unauthorized();
      principal = {
        kind: "api_key",
        keyId: key._id.toString(),
        merchantId: key.merchantId.toString(),
        mode: key.mode,
        permissions: API_KEY_PERMISSIONS,
      };
      if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
        await models.ApiKey.updateOne({ _id: key._id }, { $set: { lastUsedAt: new Date() } });
      }
    } else {
      try {
        const claims = await verifyAccessToken(credential, config.jwtSecret);
        principal = { kind: "user", ...claims, permissions: ROLE_PERMISSIONS[claims.role] };
      } catch (err) {
        if (err instanceof InvalidToken)
          throw unauthorized("The access token is invalid or expired");
        throw err;
      }
    }

    const subject =
      principal.kind === "user" ? `user:${principal.userId}` : `key:${principal.keyId}`;
    enforce(res, await rateLimiter.hit(`api:${subject}`, config.rateLimits.apiPerMinute, 60));

    req.principal = principal;
    next();
  };
}

export function principalOf(req: Request): Principal {
  if (!req.principal) throw new Error("authenticate() must run before this handler");
  return req.principal;
}

/** Dashboard-only endpoints: managing the team and keys needs a person, not an API key. */
export function userOf(req: Request): UserPrincipal {
  const principal = principalOf(req);
  if (principal.kind !== "user") {
    throw new ApiError(403, "forbidden", "This endpoint needs a dashboard login, not an API key");
  }
  return principal;
}

export function requirePermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!principalOf(req).permissions.has(permission)) {
      throw new ApiError(403, "forbidden", `This needs the ${permission} permission`);
    }
    next();
  };
}

/** Route ids that aren't valid ObjectIds can't match anything: same 404 as a missing record. */
export function objectIdParam(value: string | string[] | undefined, what: string): string {
  if (typeof value !== "string" || !isValidObjectId(value)) {
    throw new ApiError(404, "not_found", `${what} not found`);
  }
  return value;
}
