import { randomBytes } from "node:crypto";

import { Schema, type InferSchemaType, type Model, type Types } from "mongoose";

import { CURRENCIES } from "../ledger/money.js";
import { KEY_MODES } from "../models/constants.js";
import { PAYMENT_STATUSES } from "./stateMachine.js";

/** Public ids carry their type, like Stripe's: "pi_..." is obviously a payment intent. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export const paymentIntentSchema = new Schema(
  {
    _id: { type: String, default: () => newId("pi") },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    mode: { type: String, enum: KEY_MODES, required: true },
    amount: { type: Number, required: true }, // minor units (paise)
    currency: { type: String, enum: CURRENCIES, required: true },
    status: { type: String, enum: PAYMENT_STATUSES, required: true },
    description: { type: String, default: null },
    // The merchant's own order id. Unique per merchant and mode when given, so the same order
    // can't be charged through two intents.
    receipt: { type: String, default: null },
    customer: {
      email: { type: String, default: null },
      phone: { type: String, default: null },
    },
    metadata: { type: Map, of: String, default: {} },
    fee: { type: Number, default: null }, // our fee, set when the payment succeeds
    failureReason: { type: String, default: null },
    ledgerEntryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry", default: null },
    // Lets the customer's browser load and pay this one intent on the hosted checkout, and
    // nothing else. Like Stripe's client_secret: the merchant passes it to their frontend.
    clientSecret: { type: String, required: true, default: () => newId("cs") },
    // The payment as Razorpay knows it. The order is created when the checkout first opens.
    gateway: {
      provider: { type: String, enum: ["razorpay"], default: null },
      orderId: { type: String, default: null },
      paymentId: { type: String, default: null }, // the payment that succeeded
      method: { type: String, default: null }, // card, upi, netbanking, wallet...
      // Last time we asked Razorpay about this payment (reconciliation backs off on it)
      checkedAt: { type: Date, default: null },
    },
    succeededAt: { type: Date, default: null },
    canceledAt: { type: Date, default: null },
    // Incremented on every status change: the transition's optimistic-concurrency check
    version: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);
paymentIntentSchema.index({ merchantId: 1, mode: 1, createdAt: -1, _id: -1 });
paymentIntentSchema.index(
  { merchantId: 1, mode: 1, receipt: 1 },
  { unique: true, partialFilterExpression: { receipt: { $type: "string" } } },
);
// Webhooks find the intent by Razorpay's order id
paymentIntentSchema.index(
  { "gateway.orderId": 1 },
  { unique: true, partialFilterExpression: { "gateway.orderId": { $type: "string" } } },
);
// The reconciler's query: unfinished payments that have a gateway order
paymentIntentSchema.index(
  { status: 1, "gateway.checkedAt": 1 },
  { partialFilterExpression: { "gateway.orderId": { $type: "string" } } },
);

/**
 * Everything that happened to a payment, appended in the same transaction as the change
 * itself. Later branches deliver these to merchants as webhooks (a transactional outbox):
 * an event exists if and only if its change committed.
 */
export const paymentEventSchema = new Schema(
  {
    _id: { type: String, default: () => newId("evt") },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    mode: { type: String, enum: KEY_MODES, required: true },
    type: { type: String, required: true },
    paymentIntentId: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
paymentEventSchema.index({ paymentIntentId: 1, createdAt: 1 });
paymentEventSchema.index({ merchantId: 1, mode: 1, createdAt: -1 });

/** Stored responses for Idempotency-Key requests (see middleware/idempotency.ts). */
export const idempotencyRecordSchema = new Schema(
  {
    _id: { type: String }, // hash of merchant, mode and key
    requestHash: { type: String, required: true },
    state: { type: String, enum: ["in_progress", "done"], required: true },
    lockedUntil: { type: Date, required: true },
    response: {
      status: { type: Number },
      body: { type: Schema.Types.Mixed },
    },
    createdAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);
// Keys are remembered for 24 hours, like Stripe's
idempotencyRecordSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

/**
 * Every webhook Razorpay sent us, keyed by its event id. Razorpay retries deliveries and may
 * send one event more than once; the unique id makes the second copy a no-op. Kept 30 days
 * for debugging ("did the webhook ever arrive?").
 */
export const gatewayWebhookSchema = new Schema(
  {
    _id: { type: String }, // x-razorpay-event-id
    provider: { type: String, enum: ["razorpay"], required: true },
    type: { type: String, required: true },
    orderId: { type: String, default: null },
    paymentId: { type: String, default: null },
    status: { type: String, enum: ["received", "processed", "ignored", "failed"], required: true },
    error: { type: String, default: null },
    receivedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: false },
);
gatewayWebhookSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });
gatewayWebhookSchema.index({ orderId: 1, receivedAt: 1 });

export type PaymentIntent = InferSchemaType<typeof paymentIntentSchema> & { _id: string };
export type PaymentEvent = InferSchemaType<typeof paymentEventSchema> & { _id: string };
export type IdempotencyRecord = InferSchemaType<typeof idempotencyRecordSchema> & { _id: string };
export type GatewayWebhook = InferSchemaType<typeof gatewayWebhookSchema> & { _id: string };

export type PaymentModels = {
  PaymentIntent: Model<PaymentIntent>;
  PaymentEvent: Model<PaymentEvent>;
  IdempotencyRecord: Model<IdempotencyRecord>;
  GatewayWebhook: Model<GatewayWebhook>;
};

export type { Types };
