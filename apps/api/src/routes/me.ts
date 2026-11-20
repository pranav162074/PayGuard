import { Router } from "express";

import { authenticate, principalOf } from "../middleware/auth.js";
import type { RouteDeps } from "./deps.js";

export function meRouter(deps: RouteDeps): Router {
  const { models } = deps;
  const router = Router();

  /** Who is calling: a dashboard user or an API key, and for which merchant. */
  router.get("/v1/me", authenticate(deps), async (req, res) => {
    const principal = principalOf(req);
    const merchant = await models.Merchant.findById(principal.merchantId).lean();
    const permissions = [...principal.permissions].sort();
    const merchantJson = merchant ? { id: merchant._id.toString(), name: merchant.name } : null;

    if (principal.kind === "user") {
      const user = await models.User.findById(principal.userId).lean();
      res.json({
        kind: "user",
        user: user ? { id: user._id.toString(), email: user.email, name: user.name } : null,
        merchant: merchantJson,
        role: principal.role,
        permissions,
      });
      return;
    }
    const key = await models.ApiKey.findById(principal.keyId).lean();
    res.json({
      kind: "api_key",
      apiKey: key
        ? { id: key._id.toString(), name: key.name, mode: key.mode, prefix: key.prefix }
        : null,
      merchant: merchantJson,
      mode: principal.mode,
      permissions,
    });
  });

  return router;
}
