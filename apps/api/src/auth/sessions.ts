import type { Request, Response } from "express";
import type { Types } from "mongoose";

import type { Config } from "../config.js";
import type { Logger } from "../logger.js";
import type { Models, Role } from "../models/index.js";
import { newFamilyId, randomToken, sha256, signAccessToken } from "./tokens.js";

export const REFRESH_COOKIE = "pg_refresh";
// The cookie is only ever sent to the auth endpoints, never with ordinary API calls
const REFRESH_COOKIE_PATH = "/v1/auth";

type SessionDeps = { config: Config; models: Models; logger: Logger };

type SessionStart = {
  userId: Types.ObjectId;
  merchantId: Types.ObjectId;
  role: Role;
  /** Continue an existing session (a refresh) instead of starting a new one (a login). */
  familyId?: string;
  /** Sessions end a fixed time after login; refreshing doesn't extend them. */
  expiresAt?: Date;
};

export type SessionBody = { accessToken: string; tokenType: "Bearer"; expiresIn: number };

function setRefreshCookie(res: Response, config: Config, token: string, expiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true, // page scripts can't read it, so an XSS bug can't steal it
    secure: config.secureCookies,
    sameSite: "strict", // never sent on requests started by other sites
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(res: Response, config: Config): void {
  res.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "strict",
    path: REFRESH_COOKIE_PATH,
  });
}

/** Issues an access token (in the body) and the next refresh token (in an httpOnly cookie). */
export async function issueSession(
  { config, models }: SessionDeps,
  req: Request,
  res: Response,
  start: SessionStart,
): Promise<SessionBody> {
  const familyId = start.familyId ?? newFamilyId();
  const expiresAt =
    start.expiresAt ?? new Date(Date.now() + config.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  const refreshToken = randomToken();
  await models.RefreshToken.create({
    tokenHash: sha256(refreshToken),
    familyId,
    userId: start.userId,
    merchantId: start.merchantId,
    expiresAt,
    userAgent: req.get("user-agent")?.slice(0, 200) ?? null,
    ip: req.ip ?? null,
  });
  setRefreshCookie(res, config, refreshToken, expiresAt);

  const accessToken = await signAccessToken(
    {
      userId: start.userId.toString(),
      merchantId: start.merchantId.toString(),
      role: start.role,
      sessionId: familyId,
    },
    config.jwtSecret,
    config.accessTokenTtlSeconds,
  );
  return { accessToken, tokenType: "Bearer", expiresIn: config.accessTokenTtlSeconds };
}

export async function revokeFamily(models: Models, familyId: string): Promise<void> {
  await models.RefreshToken.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date() } },
  );
}

export type RotateResult =
  | {
      ok: true;
      userId: Types.ObjectId;
      merchantId: Types.ObjectId;
      familyId: string;
      expiresAt: Date;
    }
  | { ok: false; reason: "unknown" | "expired" | "reused" };

/**
 * Marks a refresh token used, in a single conditional update: if two requests present the
 * same token at once, only one of them wins. A token that was already used is treated as
 * stolen, and its whole family is revoked: either the attacker or the real user is holding
 * a copy, and we can't tell which.
 */
export async function rotateRefreshToken(
  { models, logger }: SessionDeps,
  token: string,
): Promise<RotateResult> {
  const tokenHash = sha256(token);
  const now = new Date();
  const current = await models.RefreshToken.findOneAndUpdate(
    { tokenHash, usedAt: null, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
  );
  if (current) {
    return {
      ok: true,
      userId: current.userId,
      merchantId: current.merchantId,
      familyId: current.familyId,
      expiresAt: current.expiresAt,
    };
  }

  const known = await models.RefreshToken.findOne({ tokenHash });
  if (!known) return { ok: false, reason: "unknown" };
  if (known.usedAt && !known.revokedAt) {
    await revokeFamily(models, known.familyId);
    logger.warn(
      { userId: known.userId.toString(), sessionId: known.familyId },
      "Refresh token reused; revoked the session",
    );
    return { ok: false, reason: "reused" };
  }
  return { ok: false, reason: known.revokedAt ? "reused" : "expired" };
}
