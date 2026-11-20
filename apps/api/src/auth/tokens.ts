import { createHash, randomBytes, randomUUID } from "node:crypto";

import { SignJWT, jwtVerify, errors as joseErrors } from "jose";

import type { KeyMode, Role } from "../models/index.js";

const ISSUER = "payguard";
const AUDIENCE = "payguard-dashboard";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A random, URL-safe secret: refresh tokens and invitation tokens. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function newFamilyId(): string {
  return randomUUID();
}

export type AccessClaims = {
  userId: string;
  merchantId: string;
  role: Role;
  sessionId: string;
};

/**
 * Short-lived and stateless: checked by signature alone, with no database lookup. The trade-off
 * is that a role change or logout takes effect within one token lifetime (15 minutes by
 * default), since the refresh that would issue the next token is refused immediately.
 */
export async function signAccessToken(
  claims: AccessClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ mid: claims.merchantId, role: claims.role, sid: claims.sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}

export class InvalidToken extends Error {
  override name = "InvalidToken";
}

export async function verifyAccessToken(token: string, secret: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      // Pinning the algorithm blocks "alg: none" and algorithm-swap attacks
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const { sub, mid, role, sid } = payload;
    if (
      typeof sub !== "string" ||
      typeof mid !== "string" ||
      typeof sid !== "string" ||
      (role !== "owner" && role !== "developer" && role !== "analyst")
    ) {
      throw new InvalidToken("Malformed claims");
    }
    return { userId: sub, merchantId: mid, role, sessionId: sid };
  } catch (err) {
    if (err instanceof InvalidToken || err instanceof joseErrors.JOSEError) {
      throw new InvalidToken(err.message);
    }
    throw err;
  }
}

// API keys: "sk_test_..." / "sk_live_...", like Stripe, so a leaked key's power is obvious
const API_KEY = /^sk_(test|live)_[A-Za-z0-9_-]{43}$/;
export const API_KEY_DISPLAY_LENGTH = 12;

export function generateApiKey(mode: KeyMode): string {
  return `sk_${mode}_${randomBytes(32).toString("base64url")}`;
}

export function parseApiKey(value: string): { mode: KeyMode } | null {
  const match = API_KEY.exec(value);
  return match ? { mode: match[1] as KeyMode } : null;
}
