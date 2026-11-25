import { createHash } from "node:crypto";

import express, { Router } from "express";

import { ApiError } from "../errors.js";
import { verifyWebhookSignature } from "../gateway/razorpay.js";
import { syncIntent, type CheckoutDeps } from "../payments/checkout.js";
import type { PaymentIntent } from "../payments/models.js";
import { isDuplicateKey } from "../validation.js";
import type { RouteDeps } from "./deps.js";

/** Events that can change a payment. Everything else is acknowledged and ignored. */
const HANDLED = new Set(["payment.authorized", "payment.captured", "payment.failed", "order.paid"]);

type RazorpayWebhook = {
  event?: string;
  payload?: {
    payment?: { entity?: { id?: string; order_id?: string | null } };
    order?: { entity?: { id?: string } };
  };
};

/**
 * Razorpay → us. Mounted before the JSON body parser: the signature covers the exact bytes
 * Razorpay sent, so the raw body must be verified before anything parses it.
 *
 * - Bad or missing signature: 400, nothing is touched.
 * - Each event is stored under Razorpay's event id; a redelivered event that was already
 *   handled is acknowledged without doing anything again.
 * - The webhook is treated as a hint, not as the truth: it tells us *which* payment to look
 *   at, and syncIntent() asks Razorpay's API for the current state. Out-of-order or replayed
 *   webhooks therefore can't move a payment the wrong way.
 * - If handling fails we answer 500, and Razorpay retries later.
 */
export function webhooksRouter(deps: RouteDeps): Router {
  const { models, config, logger } = deps;
  const checkout: CheckoutDeps = {
    mongo: deps.mongo,
    models,
    feeBasisPoints: config.platformFeeBps,
    gateways: deps.gateways,
    logger,
  };
  const router = Router();

  router.post(
    "/v1/webhooks/razorpay",
    express.raw({ type: "*/*", limit: "1mb" }),
    async (req, res) => {
      const secret = config.razorpay.webhookSecret;
      if (!secret) {
        throw new ApiError(503, "webhooks_not_configured", "RAZORPAY_WEBHOOK_SECRET is not set");
      }
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const signature = req.get("x-razorpay-signature") ?? "";
      if (!signature || !verifyWebhookSignature(secret, raw, signature)) {
        logger.warn({ ip: req.ip }, "Razorpay webhook with a bad signature");
        throw new ApiError(400, "invalid_signature", "Webhook signature doesn't match");
      }

      let event: RazorpayWebhook;
      try {
        event = JSON.parse(raw.toString("utf8")) as RazorpayWebhook;
      } catch {
        throw new ApiError(400, "invalid_json", "Webhook body isn't JSON");
      }
      const type = event.event ?? "unknown";
      const payment = event.payload?.payment?.entity;
      const orderId = payment?.order_id ?? event.payload?.order?.entity?.id ?? null;
      // Razorpay always sends an event id; fall back to the body's hash just in case
      const eventId =
        req.get("x-razorpay-event-id") ??
        `sha256:${createHash("sha256").update(raw).digest("hex")}`;

      try {
        await models.GatewayWebhook.create({
          _id: eventId,
          provider: "razorpay",
          type,
          orderId,
          paymentId: payment?.id ?? null,
          status: "received",
        });
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        const seen = await models.GatewayWebhook.findById(eventId).lean();
        if (seen && (seen.status === "processed" || seen.status === "ignored")) {
          res.json({ received: true, duplicate: true });
          return;
        }
        // A copy that failed (or crashed) before: handle it again
      }

      const finish = (status: "processed" | "ignored" | "failed", error: string | null = null) =>
        models.GatewayWebhook.updateOne({ _id: eventId }, { $set: { status, error } });

      const intent =
        HANDLED.has(type) && orderId
          ? await models.PaymentIntent.findOne({ "gateway.orderId": orderId }).lean<PaymentIntent>()
          : null;
      if (!intent) {
        // Not a payment-changing event, or an order that isn't ours (another app on the same
        // Razorpay account): acknowledge it so Razorpay stops retrying
        await finish("ignored");
        res.json({ received: true });
        return;
      }

      try {
        const updated = await syncIntent(checkout, intent._id);
        await finish("processed");
        logger.info(
          { eventId, type, intentId: intent._id, status: updated.status },
          "Razorpay webhook handled",
        );
        res.json({ received: true });
      } catch (err) {
        await finish("failed", err instanceof Error ? err.message : String(err));
        logger.error({ err, eventId, type, intentId: intent._id }, "Razorpay webhook failed");
        // A 5xx makes Razorpay deliver it again later
        res.status(500).json({ error: { code: "webhook_failed", message: "Try again later" } });
      }
    },
  );

  return router;
}
