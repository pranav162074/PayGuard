import { timingSafeEqual } from "node:crypto";

import { Router, type Request, type Response } from "express";
import { z } from "zod";

import { ApiError } from "../errors.js";
import { enforce } from "../middleware/auth.js";
import { confirmPayment, ensureOrder, type CheckoutDeps } from "../payments/checkout.js";
import type { PaymentIntent } from "../payments/models.js";
import { parse } from "../validation.js";
import type { RouteDeps } from "./deps.js";

/**
 * The API behind the hosted checkout (apps/checkout). No login and no API key: the customer's
 * browser proves it may see and pay one intent by presenting that intent's client secret.
 * Everything here is scoped to that single intent, and responses leak nothing but what the
 * payer needs.
 */

const secretQuery = z.object({ client_secret: z.string().min(1).max(100) });

const confirmBody = z.strictObject({
  client_secret: z.string().min(1).max(100),
  razorpay_payment_id: z.string().regex(/^pay_\w+$/),
  razorpay_order_id: z.string().regex(/^order_\w+$/),
  razorpay_signature: z.string().regex(/^[0-9a-f]{64}$/),
});

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function checkoutRouter(deps: RouteDeps): Router {
  const { models, rateLimiter } = deps;
  const checkout: CheckoutDeps = {
    mongo: deps.mongo,
    models,
    feeBasisPoints: deps.config.platformFeeBps,
    gateways: deps.gateways,
    logger: deps.logger,
  };
  const router = Router();

  /** Wrong id and wrong secret look the same, so ids can't be probed. */
  async function load(req: Request, secret: string): Promise<PaymentIntent> {
    // Generous for real customers, useless for guessing secrets
    enforce(req.res as Response, await rateLimiter.hit(`checkout:ip:${req.ip}`, 120, 60));
    const intent = await models.PaymentIntent.findById(req.params.id).lean<PaymentIntent>();
    if (!intent || !sameSecret(intent.clientSecret, secret)) {
      throw new ApiError(404, "not_found", "Payment not found");
    }
    return intent;
  }

  async function publicJson(intent: PaymentIntent) {
    const merchant = await models.Merchant.findById(intent.merchantId).lean();
    const client = deps.gateways[intent.mode];
    const orderId = intent.gateway?.orderId ?? null;
    return {
      id: intent._id,
      status: intent.status,
      amount: intent.amount,
      currency: intent.currency,
      description: intent.description,
      mode: intent.mode,
      merchant: { name: merchant?.name ?? "" },
      customer: { email: intent.customer?.email ?? null, phone: intent.customer?.phone ?? null },
      failure_reason: intent.status === "failed" ? intent.failureReason : null,
      // What the browser needs to open Razorpay's checkout (the key id is public by design)
      razorpay: orderId && client ? { key_id: client.keys.keyId, order_id: orderId } : null,
    };
  }

  router.get("/v1/checkout/:id", async (req, res) => {
    const { client_secret } = parse(secretQuery, req.query);
    const intent = await ensureOrder(checkout, await load(req, client_secret));
    res.json(await publicJson(intent));
  });

  router.post("/v1/checkout/:id/confirm", async (req, res) => {
    const body = parse(confirmBody, req.body);
    const intent = await load(req, body.client_secret);
    const updated = await confirmPayment(checkout, intent, {
      orderId: body.razorpay_order_id,
      paymentId: body.razorpay_payment_id,
      signature: body.razorpay_signature,
    });
    res.json(await publicJson(updated));
  });

  return router;
}
