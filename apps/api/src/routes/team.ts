import { Router } from "express";
import type { ClientSession, Types } from "mongoose";

import { randomToken, sha256 } from "../auth/tokens.js";
import { ApiError } from "../errors.js";
import { authenticate, objectIdParam, requirePermission, userOf } from "../middleware/auth.js";
import type { Models, Role } from "../models/index.js";
import { isDuplicateKey, parse } from "../validation.js";
import type { RouteDeps } from "./deps.js";
import { changeRoleBody, inviteBody } from "./schemas.js";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function memberNotFound(): ApiError {
  return new ApiError(404, "not_found", "Member not found");
}

/**
 * Removing or demoting an owner must never leave a merchant with none. Counting the other
 * owners isn't enough on its own: two owners demoting each other at the same moment would each
 * see one other owner and both succeed (write skew), because they update different documents.
 * Both also bump the merchant's ownershipVersion, so their transactions write the same document
 * and MongoDB aborts one of them; the retry then sees the true count.
 */
async function guardLastOwner(
  models: Models,
  session: ClientSession,
  merchantId: Types.ObjectId,
  leavingOwnerId: Types.ObjectId,
): Promise<void> {
  await models.Merchant.updateOne(
    { _id: merchantId },
    { $inc: { ownershipVersion: 1 } },
    { session },
  );
  const otherOwners = await models.Membership.countDocuments(
    { merchantId, role: "owner", userId: { $ne: leavingOwnerId } },
    { session },
  );
  if (otherOwners === 0) {
    throw new ApiError(409, "last_owner", "A merchant needs at least one owner");
  }
}

export function teamRouter(deps: RouteDeps): Router {
  const { models, mongo } = deps;
  const router = Router();
  router.use("/v1/team", authenticate(deps));

  router.get("/v1/team", requirePermission("team:read"), async (req, res) => {
    const { merchantId } = userOf(req);
    const [members, invitations] = await Promise.all([
      models.Membership.find({ merchantId })
        .sort({ createdAt: 1 })
        .populate<{ userId: { _id: Types.ObjectId; email: string; name: string } }>(
          "userId",
          "email name",
        ),
      models.Invitation.find({
        merchantId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      }).sort({ createdAt: -1 }),
    ]);
    res.json({
      members: members.map((m) => ({
        userId: m.userId._id.toString(),
        email: m.userId.email,
        name: m.userId.name,
        role: m.role,
        joinedAt: m.createdAt,
      })),
      invitations: invitations.map((i) => ({
        id: i._id.toString(),
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt,
      })),
    });
  });

  router.post("/v1/team/invitations", requirePermission("team:manage"), async (req, res) => {
    const { merchantId, userId } = userOf(req);
    const body = parse(inviteBody, req.body);

    const existingUser = await models.User.findOne({ email: body.email });
    if (
      existingUser &&
      (await models.Membership.exists({ merchantId, userId: existingUser._id }))
    ) {
      throw new ApiError(409, "already_member", "This person is already on the team");
    }

    const token = randomToken();
    try {
      const invitation = await models.Invitation.create({
        merchantId,
        email: body.email,
        role: body.role,
        tokenHash: sha256(token),
        invitedBy: userId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      });
      // Until email sending exists, the token is returned once, here, to be passed on
      res.status(201).json({
        invitation: {
          id: invitation._id.toString(),
          email: invitation.email,
          role: invitation.role,
          expiresAt: invitation.expiresAt,
        },
        token,
      });
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw new ApiError(409, "invitation_exists", "This email already has an open invitation");
      }
      throw err;
    }
  });

  router.delete("/v1/team/invitations/:id", requirePermission("team:manage"), async (req, res) => {
    const { merchantId } = userOf(req);
    const id = objectIdParam(req.params.id, "Invitation");
    const revoked = await models.Invitation.updateOne(
      { _id: id, merchantId, acceptedAt: null, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    if (revoked.modifiedCount !== 1) throw new ApiError(404, "not_found", "Invitation not found");
    res.status(204).end();
  });

  router.patch("/v1/team/members/:userId", requirePermission("team:manage"), async (req, res) => {
    const { merchantId } = userOf(req);
    const memberId = objectIdParam(req.params.userId, "Member");
    const { role } = parse(changeRoleBody, req.body);

    let updatedRole: Role | undefined;
    await mongo.transaction(async (session) => {
      const membership = await models.Membership.findOne({ merchantId, userId: memberId }, null, {
        session,
      });
      if (!membership) throw memberNotFound();
      if (membership.role === "owner" && role !== "owner") {
        await guardLastOwner(models, session, membership.merchantId, membership.userId);
      }
      membership.role = role;
      await membership.save({ session });
      updatedRole = membership.role;
    });
    // Their next refresh picks up the new role; their current access token keeps the old one
    // until it expires
    res.json({ userId: memberId, role: updatedRole });
  });

  router.delete("/v1/team/members/:userId", requirePermission("team:manage"), async (req, res) => {
    const { merchantId } = userOf(req);
    const memberId = objectIdParam(req.params.userId, "Member");

    await mongo.transaction(async (session) => {
      const membership = await models.Membership.findOne({ merchantId, userId: memberId }, null, {
        session,
      });
      if (!membership) throw memberNotFound();
      if (membership.role === "owner") {
        await guardLastOwner(models, session, membership.merchantId, membership.userId);
      }
      await models.Membership.deleteOne({ _id: membership._id }, { session });
      // Log them out of this merchant everywhere
      await models.RefreshToken.updateMany(
        { userId: membership.userId, merchantId, revokedAt: null },
        { $set: { revokedAt: new Date() } },
        { session },
      );
    });
    res.status(204).end();
  });

  return router;
}
