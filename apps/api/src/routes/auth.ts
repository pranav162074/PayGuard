import { Router, type Request } from "express";
import { Types } from "mongoose";

import { DUMMY_HASH, hashPassword, verifyPassword } from "../auth/passwords.js";
import {
  clearRefreshCookie,
  issueSession,
  REFRESH_COOKIE,
  revokeFamily,
  rotateRefreshToken,
} from "../auth/sessions.js";
import { sha256 } from "../auth/tokens.js";
import { ApiError } from "../errors.js";
import { authenticate, enforce, userOf } from "../middleware/auth.js";
import { allowedOrigins } from "../middleware/origin.js";
import { duplicateField, isDuplicateKey, parse } from "../validation.js";
import type { RouteDeps } from "./deps.js";
import { acceptInvitationBody, loginBody, signupBody } from "./schemas.js";

const FIFTEEN_MINUTES = 15 * 60;
const HOUR = 60 * 60;

function invalidCredentials(): ApiError {
  // One message for "no such user" and "wrong password", so it doesn't reveal which emails exist
  return new ApiError(401, "invalid_credentials", "Email or password is incorrect");
}

function invalidSession(): ApiError {
  return new ApiError(401, "invalid_session", "Your session has ended. Log in again.");
}

function refreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined>;
  return cookies[REFRESH_COOKIE];
}

export function authRouter(deps: RouteDeps): Router {
  const { config, models, mongo, rateLimiter } = deps;
  const router = Router();
  const limits = config.rateLimits;

  router.post("/v1/auth/signup", async (req, res) => {
    enforce(res, await rateLimiter.hit(`signup:ip:${req.ip}`, limits.signupPerIp, HOUR));
    const body = parse(signupBody, req.body);
    // Hashing is slow on purpose; do it before the transaction so it doesn't hold one open
    const passwordHash = await hashPassword(body.password);

    const userId = new Types.ObjectId();
    const merchantId = new Types.ObjectId();
    try {
      // All three or none: no user without a merchant, no merchant without an owner
      await mongo.transaction(async (session) => {
        await models.User.create(
          [{ _id: userId, email: body.email, name: body.name, passwordHash }],
          { session },
        );
        await models.Merchant.create([{ _id: merchantId, name: body.businessName }], { session });
        await models.Membership.create([{ userId, merchantId, role: "owner" }], { session });
      });
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new ApiError(409, "email_taken", "An account with this email already exists");
      }
      throw err;
    }

    const session = await issueSession(deps, req, res, { userId, merchantId, role: "owner" });
    res.status(201).json({
      ...session,
      user: { id: userId.toString(), email: body.email, name: body.name },
      merchant: { id: merchantId.toString(), name: body.businessName },
      role: "owner",
    });
  });

  router.post("/v1/auth/login", async (req, res) => {
    const body = parse(loginBody, req.body);
    // Per IP stops one machine guessing across many accounts; per email stops many machines
    // guessing one account
    enforce(res, await rateLimiter.hit(`login:ip:${req.ip}`, limits.loginPerIp, FIFTEEN_MINUTES));
    enforce(
      res,
      await rateLimiter.hit(
        `login:email:${sha256(body.email)}`,
        limits.loginPerEmail,
        FIFTEEN_MINUTES,
      ),
    );

    const user = await models.User.findOne({ email: body.email });
    const passwordOk = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !passwordOk) throw invalidCredentials();

    const memberships = await models.Membership.find({ userId: user._id })
      .sort({ createdAt: 1 })
      .populate<{ merchantId: { _id: Types.ObjectId; name: string } }>("merchantId", "name");
    const chosen = body.merchantId
      ? memberships.find((m) => m.merchantId._id.toString() === body.merchantId)
      : memberships[0];
    if (!chosen) {
      throw new ApiError(403, "no_access", "This account has no access to that merchant");
    }

    const session = await issueSession(deps, req, res, {
      userId: user._id,
      merchantId: chosen.merchantId._id,
      role: chosen.role,
    });
    res.json({
      ...session,
      user: { id: user._id.toString(), email: user.email, name: user.name },
      merchant: { id: chosen.merchantId._id.toString(), name: chosen.merchantId.name },
      role: chosen.role,
      // Everything this person can switch to, by logging in with merchantId
      merchants: memberships.map((m) => ({
        id: m.merchantId._id.toString(),
        name: m.merchantId.name,
        role: m.role,
      })),
    });
  });

  router.post("/v1/auth/refresh", allowedOrigins(config.corsOrigins), async (req, res) => {
    const token = refreshCookie(req);
    if (!token) throw invalidSession();

    const rotated = await rotateRefreshToken(deps, token);
    if (!rotated.ok) {
      clearRefreshCookie(res, config);
      throw invalidSession();
    }
    // Roles can change and people can be removed: read the membership fresh every refresh
    const membership = await models.Membership.findOne({
      userId: rotated.userId,
      merchantId: rotated.merchantId,
    });
    if (!membership) {
      await revokeFamily(models, rotated.familyId);
      clearRefreshCookie(res, config);
      throw invalidSession();
    }

    res.json(
      await issueSession(deps, req, res, {
        userId: rotated.userId,
        merchantId: rotated.merchantId,
        role: membership.role,
        familyId: rotated.familyId,
        expiresAt: rotated.expiresAt,
      }),
    );
  });

  router.post("/v1/auth/logout", allowedOrigins(config.corsOrigins), async (req, res) => {
    const token = refreshCookie(req);
    if (token) {
      const known = await models.RefreshToken.findOne({ tokenHash: sha256(token) });
      if (known) await revokeFamily(models, known.familyId);
    }
    clearRefreshCookie(res, config);
    res.status(204).end();
  });

  router.post("/v1/auth/logout-all", authenticate(deps), async (req, res) => {
    const user = userOf(req);
    await models.RefreshToken.updateMany(
      { userId: user.userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    clearRefreshCookie(res, config);
    res.status(204).end();
  });

  router.post("/v1/auth/accept-invitation", async (req, res) => {
    enforce(res, await rateLimiter.hit(`login:ip:${req.ip}`, limits.loginPerIp, FIFTEEN_MINUTES));
    const body = parse(acceptInvitationBody, req.body);
    const invitation = await models.Invitation.findOne({
      tokenHash: sha256(body.token),
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!invitation) {
      throw new ApiError(404, "invitation_not_found", "This invitation is invalid or has expired");
    }

    // An existing account proves it's theirs with their password; a new one sets it
    let user = await models.User.findOne({ email: invitation.email });
    let newUser: { _id: Types.ObjectId; passwordHash: string; name: string } | null = null;
    if (user) {
      if (!(await verifyPassword(body.password, user.passwordHash))) throw invalidCredentials();
    } else {
      const password = parse(signupBody.shape.password, body.password);
      if (!body.name) {
        throw new ApiError(422, "validation_error", "The request has invalid fields", [
          { field: "name", message: "Needed to create your account" },
        ]);
      }
      newUser = {
        _id: new Types.ObjectId(),
        passwordHash: await hashPassword(password),
        name: body.name,
      };
    }

    try {
      await mongo.transaction(async (session) => {
        // Conditional, so the same invitation can't be accepted twice at once
        const claimed = await models.Invitation.updateOne(
          { _id: invitation._id, acceptedAt: null, revokedAt: null },
          { $set: { acceptedAt: new Date() } },
          { session },
        );
        if (claimed.modifiedCount !== 1) {
          throw new ApiError(
            404,
            "invitation_not_found",
            "This invitation is invalid or has expired",
          );
        }
        if (newUser) {
          await models.User.create([{ ...newUser, email: invitation.email }], { session });
        }
        await models.Membership.create(
          [
            {
              userId: user?._id ?? newUser?._id,
              merchantId: invitation.merchantId,
              role: invitation.role,
            },
          ],
          { session },
        );
      });
    } catch (err) {
      const field = duplicateField(err);
      if (field === "email") {
        throw new ApiError(409, "email_taken", "An account with this email already exists");
      }
      if (field) {
        throw new ApiError(409, "already_member", "You're already a member of this merchant");
      }
      throw err;
    }

    user ??= await models.User.findById(newUser?._id);
    if (!user) throw new Error("User missing right after creation");
    const merchant = await models.Merchant.findById(invitation.merchantId);
    const session = await issueSession(deps, req, res, {
      userId: user._id,
      merchantId: invitation.merchantId,
      role: invitation.role,
    });
    res.status(201).json({
      ...session,
      user: { id: user._id.toString(), email: user.email, name: user.name },
      merchant: { id: invitation.merchantId.toString(), name: merchant?.name ?? "" },
      role: invitation.role,
    });
  });

  return router;
}
