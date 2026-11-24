import { Router, type Request } from "express";
import { Types } from "mongoose";
import { z } from "zod";

import { ApiError } from "../errors.js";
import { GatewayError } from "../gateway/razorpay.js";
import { MAX_AMOUNT } from "../ledger/money.js";
import { authenticate, principalOf, requirePermission } from "../middleware/auth.js";
import { idempotency } from "../middleware/idempotency.js";
import { KEY_MODES, type KeyMode } from "../models/index.js";
import type { PaymentIntent } from "../payments/models.js";
import {
  cancelIntent,
  createIntent,
  failIntent,
  succeedIntent,
  type PaymentDeps,
} from "../payments/service.js";
import { syncIntent, type CheckoutDeps } from "../payments/checkout.js";
import { PAYMENT_STATUSES } from "../payments/stateMachine.js";
import { duplicateField, parse } from "../validation.js";
import type { RouteDeps } from "./deps.js";

// ₹1 is the smallest payment card networks and Razorpay accept
const MIN_AMOUNT = 100;

const createBody = z.strictObject({
  amount: z
    .number()
    .int("Use whole paise: 500 means ₹5.00")
    .min(MIN_AMOUNT, `At least ${MIN_AMOUNT} paise (₹1)`)
    .max(MAX_AMOUNT),
  currency: z.enum(["INR"]).default("INR"),
  description: z.string().trim().max(500).optional(),
  receipt: z.string().trim().min(1).max(64).optional(),
  customer: z
    .strictObject({
      email: z.email().max(254).optional(),
      phone: z
        .string()
        .regex(/^\+?[0-9]{8,15}$/)
        .optional(),
    })
    .optional(),
  // Free-form key/value pairs for the merchant's own bookkeeping, with Stripe's limits
  metadata: z
    .record(z.string().min(1).max(40), z.string().max(500))
    .refine((m) => Object.keys(m).length <= 20, "At most 20 keys")
    .optional(),
});

const listQuery = z.object({
  mode: z.enum(KEY_MODES).optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  starting_after: z.string().optional(),
});

const testActionBody = z.strictObject({
  outcome: z.enum(["succeed", "fail"]),
  failure_reason: z.string().max(200).optional(),
});

function modeOf(req: Request): KeyMode {
  const principal = principalOf(req);
  if (principal.kind === "api_key") return principal.mode;
  return parse(z.object({ mode: z.enum(KEY_MODES).default("test") }), req.query).mode;
}

/** Mongoose gives a Map on documents and a plain object on lean reads. */
function metadataOf(intent: PaymentIntent): Record<string, string> {
  const raw = intent.metadata as unknown as Map<string, string> | Record<string, string> | null;
  if (!raw) return {};
  return raw instanceof Map ? Object.fromEntries(raw) : { ...raw };
}

export function intentJson(intent: PaymentIntent, checkoutUrl: string) {
  const checkoutOpen = intent.status === "requires_payment" || intent.status === "failed";
  return {
    id: intent._id,
    object: "payment_intent",
    amount: intent.amount,
    currency: intent.currency,
    status: intent.status,
    mode: intent.mode,
    description: intent.description,
    receipt: intent.receipt,
    customer: { email: intent.customer?.email ?? null, phone: intent.customer?.phone ?? null },
    metadata: metadataOf(intent),
    fee: intent.fee ?? null,
    net: typeof intent.fee === "number" ? intent.amount - intent.fee : null,
    failure_reason: intent.failureReason,
    ledger_entry_id: intent.ledgerEntryId?.toString() ?? null,
    // Give these to the customer's browser: the hosted page, or your own page using the
    // secret with GET /v1/checkout/{id}
    client_secret: intent.clientSecret,
    checkout_url: checkoutOpen
      ? `${checkoutUrl}/pay/${intent._id}?client_secret=${encodeURIComponent(intent.clientSecret)}`
      : null,
    gateway: {
      provider: intent.gateway?.provider ?? null,
      order_id: intent.gateway?.orderId ?? null,
      payment_id: intent.gateway?.paymentId ?? null,
      method: intent.gateway?.method ?? null,
    },
    created_at: intent.createdAt,
    succeeded_at: intent.succeededAt,
    canceled_at: intent.canceledAt,
  };
}

export function paymentsRouter(deps: RouteDeps): Router {
  const { models, config, logger } = deps;
  const payments: PaymentDeps = {
    mongo: deps.mongo,
    models,
    feeBasisPoints: config.platformFeeBps,
  };
  const checkout: CheckoutDeps = { ...payments, gateways: deps.gateways, logger };
  const router = Router();
  router.use("/v1/payment_intents", authenticate(deps));
  const write = [requirePermission("payments:write"), idempotency(models, logger)];

  /** Scoped to the caller's merchant and mode: anything else is "not found". */
  async function load(req: Request): Promise<PaymentIntent> {
    const intent = await models.PaymentIntent.findOne({
      _id: req.params.id,
      merchantId: principalOf(req).merchantId,
      mode: modeOf(req),
    }).lean<PaymentIntent>();
    if (!intent) throw new ApiError(404, "not_found", "Payment intent not found");
    return intent;
  }

  router.post("/v1/payment_intents", ...write, async (req, res) => {
    const body = parse(createBody, req.body);
    try {
      const intent = await createIntent(payments, {
        merchantId: new Types.ObjectId(principalOf(req).merchantId),
        mode: modeOf(req),
        amount: body.amount,
        currency: body.currency,
        description: body.description ?? null,
        receipt: body.receipt ?? null,
        customer: { email: body.customer?.email ?? null, phone: body.customer?.phone ?? null },
        metadata: new Map(Object.entries(body.metadata ?? {})),
      });
      res.status(201).json(intentJson(intent, config.checkoutUrl));
    } catch (err) {
      if (duplicateField(err) === "merchantId") {
        throw new ApiError(
          409,
          "duplicate_receipt",
          "A payment intent with this receipt already exists",
        );
      }
      throw err;
    }
  });

  router.get("/v1/payment_intents", requirePermission("payments:read"), async (req, res) => {
    const query = parse(listQuery, req.query);
    const filter: Record<string, unknown> = {
      merchantId: principalOf(req).merchantId,
      mode: modeOf(req),
    };
    if (query.status) filter.status = query.status;
    if (query.starting_after) {
      const after = await models.PaymentIntent.findOne({
        ...filter,
        _id: query.starting_after,
      }).lean();
      if (!after)
        throw new ApiError(422, "invalid_cursor", "starting_after is not a payment intent here");
      filter.$or = [
        { createdAt: { $lt: after.createdAt } },
        { createdAt: after.createdAt, _id: { $lt: after._id } },
      ];
    }
    const rows = await models.PaymentIntent.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .lean<PaymentIntent[]>();
    res.json({
      object: "list",
      data: rows.slice(0, query.limit).map((row) => intentJson(row, config.checkoutUrl)),
      has_more: rows.length > query.limit,
    });
  });

  router.get("/v1/payment_intents/:id", requirePermission("payments:read"), async (req, res) => {
    res.json(intentJson(await load(req), config.checkoutUrl));
  });

  router.get(
    "/v1/payment_intents/:id/events",
    requirePermission("payments:read"),
    async (req, res) => {
      const intent = await load(req);
      const events = await models.PaymentEvent.find({ paymentIntentId: intent._id })
        .sort({ createdAt: 1, _id: 1 })
        .lean();
      res.json({
        object: "list",
        data: events.map((e) => ({
          id: e._id,
          type: e.type,
          data: e.data as unknown,
          created_at: e.createdAt,
        })),
      });
    },
  );

  router.post("/v1/payment_intents/:id/cancel", ...write, async (req, res) => {
    const intent = await load(req);
    res.json(intentJson(await cancelIntent(payments, intent._id), config.checkoutUrl));
  });

  /**
   * Ask Razorpay about this payment now (a customer says they paid but the checkout never
   * confirmed, say). Safe to call any number of times.
   */
  router.post(
    "/v1/payment_intents/:id/sync",
    requirePermission("payments:write"),
    async (req, res) => {
      const intent = await load(req);
      try {
        res.json(intentJson(await syncIntent(checkout, intent._id), config.checkoutUrl));
      } catch (err) {
        if (err instanceof GatewayError) {
          throw new ApiError(502, "gateway_error", `The payment gateway failed: ${err.message}`);
        }
        throw err;
      }
    },
  );

  /**
   * Test mode only: pretend the customer paid (or the payment failed), so the whole flow,
   * ledger included, can be exercised before a real gateway is wired in. Like Stripe's test
   * helpers. Real payments will reach the same code through gateway webhooks.
   */
  router.post("/v1/payment_intents/:id/test_actions", ...write, async (req, res) => {
    if (modeOf(req) !== "test") {
      throw new ApiError(403, "test_mode_only", "Test actions only work on test-mode payments");
    }
    const intent = await load(req);
    const body = parse(testActionBody, req.body);
    const updated =
      body.outcome === "succeed"
        ? await succeedIntent(payments, intent._id)
        : await failIntent(payments, intent._id, body.failure_reason ?? "card_declined");
    res.json(intentJson(updated, config.checkoutUrl));
  });

  return router;
}
