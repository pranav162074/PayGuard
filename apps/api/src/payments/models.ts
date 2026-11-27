import { randomBytes } from "node:crypto";

import { Schema, type InferSchemaType, type Model, type Types } from "mongoose";

import { CURRENCIES } from "../ledger/money.js";
import { KEY_MODES } from "../models/constants.js";
import { PAYMENT_STATUSES } from "./stateMachine.js";

/** Payments created before refunds existed have no amountRefunded on disk: that means 0. */
export function refundedOf(intent: Pick<PaymentIntent, "amountRefunded">): number {
  return (intent as { amountRefunded?: number }).amountRefunded ?? 0;
}

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
    // Refunded so far, including refunds still in progress: reserved atomically when a refund
    // starts, so concurrent refunds can never add up to more than the payment
    amountRefunded: { type: Number, required: true, default: 0 },
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
    // The outbox: set once the event has been turned into webhook deliveries
    deliveredAt: { type: Date, default: null },
    // A dispatcher working on it; another may take over if this is old (it crashed)
    fanoutClaimedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
// Finding the next undelivered events, oldest first
paymentEventSchema.index({ deliveredAt: 1, createdAt: 1 });
paymentEventSchema.index({ paymentIntentId: 1, createdAt: 1 });
paymentEventSchema.index({ merchantId: 1, mode: 1, createdAt: -1 });

export const REFUND_STATUSES = ["pending", "succeeded", "failed"] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const REFUND_REASONS = [
  "requested_by_customer",
  "duplicate",
  "fraudulent",
  "other",
] as const;

/**
 * Money going back to a customer. Its amount is reserved on the payment and taken out of the
 * merchant's balance (one ledger entry) the moment it's created; if the gateway then fails
 * it, both are undone (a reversing entry), so the books never show money that didn't move.
 */
export const refundSchema = new Schema(
  {
    _id: { type: String, default: () => newId("re") },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    mode: { type: String, enum: KEY_MODES, required: true },
    paymentIntentId: { type: String, required: true },
    amount: { type: Number, required: true }, // paise
    currency: { type: String, enum: CURRENCIES, required: true },
    // Our share of the processing fee given back with this refund (see refundLines)
    feeReturned: { type: Number, required: true },
    reason: { type: String, enum: REFUND_REASONS, required: true },
    note: { type: String, default: null },
    status: { type: String, enum: REFUND_STATUSES, required: true },
    failureReason: { type: String, default: null },
    gateway: {
      provider: { type: String, enum: ["razorpay", "none"], required: true },
      refundId: { type: String, default: null }, // rfnd_...
      checkedAt: { type: Date, default: null },
    },
    ledgerEntryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry", default: null },
    reversalEntryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry", default: null },
    succeededAt: { type: Date, default: null },
  },
  { timestamps: true },
);
refundSchema.index({ paymentIntentId: 1, createdAt: 1 });
refundSchema.index({ merchantId: 1, mode: 1, createdAt: -1, _id: -1 });
refundSchema.index(
  { "gateway.refundId": 1 },
  { unique: true, partialFilterExpression: { "gateway.refundId": { $type: "string" } } },
);
// The reconciler's query: refunds the gateway hasn't finished
refundSchema.index({ status: 1, "gateway.checkedAt": 1 });

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
export type Refund = InferSchemaType<typeof refundSchema> & { _id: string };

export type PaymentModels = {
  PaymentIntent: Model<PaymentIntent>;
  PaymentEvent: Model<PaymentEvent>;
  IdempotencyRecord: Model<IdempotencyRecord>;
  GatewayWebhook: Model<GatewayWebhook>;
  Refund: Model<Refund>;
};

export type { Types };
