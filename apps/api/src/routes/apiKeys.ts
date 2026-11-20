import { Router } from "express";

import { API_KEY_DISPLAY_LENGTH, generateApiKey, sha256 } from "../auth/tokens.js";
import { ApiError } from "../errors.js";
import { authenticate, objectIdParam, requirePermission, userOf } from "../middleware/auth.js";
import type { ApiKey } from "../models/index.js";
import { parse } from "../validation.js";
import type { RouteDeps } from "./deps.js";
import { createApiKeyBody } from "./schemas.js";

function toJson(key: ApiKey) {
  return {
    id: key._id.toString(),
    name: key.name,
    mode: key.mode,
    prefix: key.prefix,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
  };
}

export function apiKeysRouter(deps: RouteDeps): Router {
  const { models } = deps;
  const router = Router();
  router.use("/v1/api-keys", authenticate(deps));

  router.post("/v1/api-keys", requirePermission("api_keys:manage"), async (req, res) => {
    const { merchantId, userId } = userOf(req);
    const body = parse(createApiKeyBody, req.body);
    const secret = generateApiKey(body.mode);
    const key = await models.ApiKey.create({
      merchantId,
      name: body.name,
      mode: body.mode,
      prefix: secret.slice(0, API_KEY_DISPLAY_LENGTH),
      keyHash: sha256(secret),
      createdBy: userId,
    });
    // The only time the full key is ever shown; only its hash is stored
    res.status(201).json({ ...toJson(key.toObject()), key: secret });
  });

  router.get("/v1/api-keys", requirePermission("api_keys:read"), async (req, res) => {
    const { merchantId } = userOf(req);
    const keys = await models.ApiKey.find({ merchantId }).sort({ createdAt: -1, _id: -1 }).lean();
    res.json(keys.map(toJson));
  });

  router.delete("/v1/api-keys/:id", requirePermission("api_keys:manage"), async (req, res) => {
    const { merchantId } = userOf(req);
    const id = objectIdParam(req.params.id, "API key");
    // Scoped to the caller's merchant: another merchant's key is "not found", not "forbidden"
    const revoked = await models.ApiKey.updateOne(
      { _id: id, merchantId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    if (revoked.modifiedCount !== 1) throw new ApiError(404, "not_found", "API key not found");
    res.status(204).end();
  });

  return router;
}
