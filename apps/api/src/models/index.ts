import {
  ledgerAccountSchema,
  ledgerEntrySchema,
  ledgerPostingSchema,
  type LedgerAccount,
  type LedgerEntry,
  type LedgerModels,
  type LedgerPosting,
} from "../ledger/models.js";
import {
  gatewayWebhookSchema,
  idempotencyRecordSchema,
  refundSchema,
  paymentEventSchema,
  paymentIntentSchema,
  type GatewayWebhook,
  type IdempotencyRecord,
  type PaymentEvent,
  type PaymentIntent,
  type Refund,
  type PaymentModels,
} from "../payments/models.js";
import {
  webhookDeliverySchema,
  webhookEndpointSchema,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookModels,
} from "../webhooks/models.js";
import { Schema, type Connection, type InferSchemaType, type Model, type Types } from "mongoose";

import { KEY_MODES, ROLES, type KeyMode, type Role } from "./constants.js";

export { KEY_MODES, ROLES, type KeyMode, type Role };

const timestamps = { timestamps: { createdAt: true, updatedAt: true } } as const;

const userSchema = new Schema(
  {
    // Stored lowercased, so "Ana@X.com" and "ana@x.com" are the same account
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
  },
  timestamps,
);
userSchema.index({ email: 1 }, { unique: true });

const merchantSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // Bumped by any change to who the owners are. Two concurrent changes then touch the same
    // document, so MongoDB aborts one of them instead of letting both pass (see team.ts).
    ownershipVersion: { type: Number, required: true, default: 0 },
  },
  timestamps,
);

const membershipSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    role: { type: String, enum: ROLES, required: true },
  },
  timestamps,
);
membershipSchema.index({ userId: 1, merchantId: 1 }, { unique: true });
membershipSchema.index({ merchantId: 1, role: 1 });

const invitationSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ROLES, required: true },
    tokenHash: { type: String, required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  timestamps,
);
invitationSchema.index({ tokenHash: 1 }, { unique: true });
// At most one open invitation per email per merchant
invitationSchema.index(
  { merchantId: 1, email: 1 },
  { unique: true, partialFilterExpression: { acceptedAt: null, revokedAt: null } },
);

/**
 * One refresh token. Tokens from the same login form a family: each refresh marks the old
 * token used and issues the next one in the family. Presenting a used token again means it
 * was copied, so the whole family (the session) is revoked.
 */
const refreshTokenSchema = new Schema(
  {
    tokenHash: { type: String, required: true },
    familyId: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
refreshTokenSchema.index({ tokenHash: 1 }, { unique: true });
refreshTokenSchema.index({ familyId: 1 });
refreshTokenSchema.index({ userId: 1 });
// MongoDB deletes expired tokens by itself
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const apiKeySchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    name: { type: String, required: true, trim: true },
    mode: { type: String, enum: KEY_MODES, required: true },
    // The first characters, safe to show (like "sk_test_4f9a"), so people can tell keys apart
    prefix: { type: String, required: true },
    keyHash: { type: String, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  timestamps,
);
apiKeySchema.index({ keyHash: 1 }, { unique: true });
apiKeySchema.index({ merchantId: 1, createdAt: -1 });

export type User = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export type Merchant = InferSchemaType<typeof merchantSchema> & { _id: Types.ObjectId };
export type Membership = InferSchemaType<typeof membershipSchema> & { _id: Types.ObjectId };
export type Invitation = InferSchemaType<typeof invitationSchema> & { _id: Types.ObjectId };
export type RefreshToken = InferSchemaType<typeof refreshTokenSchema> & { _id: Types.ObjectId };
export type ApiKey = InferSchemaType<typeof apiKeySchema> & { _id: Types.ObjectId };

export type Models = LedgerModels &
  PaymentModels &
  WebhookModels & {
    User: Model<User>;
    Merchant: Model<Merchant>;
    Membership: Model<Membership>;
    Invitation: Model<Invitation>;
    RefreshToken: Model<RefreshToken>;
    ApiKey: Model<ApiKey>;
  };

/** Registers the models on one connection (not mongoose's global one). */
export function registerModels(connection: Connection): Models {
  return {
    User: connection.model<User>("User", userSchema, "users"),
    Merchant: connection.model<Merchant>("Merchant", merchantSchema, "merchants"),
    Membership: connection.model<Membership>("Membership", membershipSchema, "memberships"),
    Invitation: connection.model<Invitation>("Invitation", invitationSchema, "invitations"),
    RefreshToken: connection.model<RefreshToken>(
      "RefreshToken",
      refreshTokenSchema,
      "refresh_tokens",
    ),
    ApiKey: connection.model<ApiKey>("ApiKey", apiKeySchema, "api_keys"),
    LedgerAccount: connection.model<LedgerAccount>(
      "LedgerAccount",
      ledgerAccountSchema,
      "ledger_accounts",
    ),
    LedgerEntry: connection.model<LedgerEntry>("LedgerEntry", ledgerEntrySchema, "ledger_entries"),
    PaymentIntent: connection.model<PaymentIntent>(
      "PaymentIntent",
      paymentIntentSchema,
      "payment_intents",
    ),
    PaymentEvent: connection.model<PaymentEvent>(
      "PaymentEvent",
      paymentEventSchema,
      "payment_events",
    ),
    IdempotencyRecord: connection.model<IdempotencyRecord>(
      "IdempotencyRecord",
      idempotencyRecordSchema,
      "idempotency_keys",
    ),
    GatewayWebhook: connection.model<GatewayWebhook>(
      "GatewayWebhook",
      gatewayWebhookSchema,
      "gateway_webhooks",
    ),
    Refund: connection.model<Refund>("Refund", refundSchema, "refunds"),
    WebhookEndpoint: connection.model<WebhookEndpoint>(
      "WebhookEndpoint",
      webhookEndpointSchema,
      "webhook_endpoints",
    ),
    WebhookDelivery: connection.model<WebhookDelivery>(
      "WebhookDelivery",
      webhookDeliverySchema,
      "webhook_deliveries",
    ),
    LedgerPosting: connection.model<LedgerPosting>(
      "LedgerPosting",
      ledgerPostingSchema,
      "ledger_postings",
    ),
  };
}

/** Builds the indexes declared above. Run at startup, before serving traffic. */
export async function ensureIndexes(models: Models): Promise<void> {
  const all: { createIndexes: () => Promise<unknown> }[] = Object.values(models);
  await Promise.all(all.map((model) => model.createIndexes()));
}
