import { Schema, type InferSchemaType, type Model } from "mongoose";

import { KEY_MODES } from "../models/constants.js";
import { newId } from "../payments/models.js";

/** Every event a merchant can subscribe to. "*" means all of them, including future ones. */
export const EVENT_TYPES = [
  "payment_intent.created",
  "payment_intent.processing",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "payment_intent.canceled",
  "payment_intent.refunded",
  "refund.created",
  "refund.succeeded",
  "refund.failed",
] as const;

export const DELIVERY_STATUSES = ["pending", "retrying", "succeeded", "dead"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Where a merchant wants events sent. The signing secret is stored encrypted (AES-256-GCM)
 * because we need it back to sign with; it's shown to the merchant only when created or
 * rotated. After a rotation the previous secret keeps signing (alongside the new one) until
 * it expires, so the merchant can switch over without missing deliveries.
 */
export const webhookEndpointSchema = new Schema(
  {
    _id: { type: String, default: () => newId("we") },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    mode: { type: String, enum: KEY_MODES, required: true },
    url: { type: String, required: true },
    description: { type: String, default: null },
    enabledEvents: { type: [String], required: true },
    status: { type: String, enum: ["enabled", "disabled"], required: true, default: "enabled" },
    secrets: {
      type: [
        new Schema(
          {
            encrypted: { type: String, required: true },
            createdAt: { type: Date, required: true },
            // null for the current secret; set on the previous one when rotated
            expiresAt: { type: Date, default: null },
          },
          { _id: false },
        ),
      ],
      required: true,
    },
  },
  { timestamps: true },
);
webhookEndpointSchema.index({ merchantId: 1, mode: 1, status: 1 });

const attemptSchema = new Schema(
  {
    at: { type: Date, required: true },
    statusCode: { type: Number, default: null },
    durationMs: { type: Number, required: true },
    error: { type: String, default: null },
    // The start of what the merchant's server answered, for debugging their handler
    responseBody: { type: String, default: null },
  },
  { _id: false },
);

/** One event on its way to one endpoint, with a log of every attempt. */
export const webhookDeliverySchema = new Schema(
  {
    _id: { type: String, default: () => newId("whd") },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    mode: { type: String, enum: KEY_MODES, required: true },
    endpointId: { type: String, required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    // Only for test pings, which have no stored event
    payload: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: DELIVERY_STATUSES, required: true, default: "pending" },
    attemptCount: { type: Number, required: true, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lastAttemptAt: { type: Date, default: null },
    succeededAt: { type: Date, default: null },
    // Manual retries from the dead-letter queue
    replays: { type: Number, required: true, default: 0 },
    attempts: { type: [attemptSchema], default: [] },
  },
  { timestamps: true },
);
// The dispatcher may run twice for one event (a crash between steps): one delivery each
webhookDeliverySchema.index({ eventId: 1, endpointId: 1 }, { unique: true });
webhookDeliverySchema.index({ endpointId: 1, createdAt: -1 });
webhookDeliverySchema.index({ merchantId: 1, mode: 1, status: 1, createdAt: -1 });
// Delivery logs are kept for 30 days
webhookDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export type WebhookEndpoint = InferSchemaType<typeof webhookEndpointSchema> & { _id: string };
export type WebhookDelivery = InferSchemaType<typeof webhookDeliverySchema> & { _id: string };

export type WebhookModels = {
  WebhookEndpoint: Model<WebhookEndpoint>;
  WebhookDelivery: Model<WebhookDelivery>;
};
