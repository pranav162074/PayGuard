import { Schema, type InferSchemaType, type Model, type Types } from "mongoose";

import { KEY_MODES } from "../models/constants.js";
import { ACCOUNT_TYPES } from "./chart.js";
import { CURRENCIES } from "./money.js";

const DIRECTIONS = ["debit", "credit"] as const;

export const ledgerAccountSchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    mode: { type: String, enum: KEY_MODES, required: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: ACCOUNT_TYPES, required: true },
    currency: { type: String, enum: CURRENCIES, required: true },
    allowNegative: { type: Boolean, required: true },
    // Cached from the postings, in minor units, normal-side positive. Updated in the same
    // transaction as every posting, and checked against the postings by verifyLedger().
    balance: { type: Number, required: true, default: 0 },
    debits: { type: Number, required: true, default: 0 },
    credits: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);
ledgerAccountSchema.index({ merchantId: 1, mode: 1, code: 1 }, { unique: true });

const lineSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    accountCode: { type: String, required: true },
    direction: { type: String, enum: DIRECTIONS, required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
);

/** One business event (a capture, a refund, a settlement): balanced lines, never edited. */
export const ledgerEntrySchema = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    mode: { type: String, enum: KEY_MODES, required: true },
    currency: { type: String, enum: CURRENCIES, required: true },
    description: { type: String, required: true },
    // A retried posting with the same key returns the original entry instead of posting twice
    idempotencyKey: { type: String, required: true },
    // Hash of the entry's content: the same key with different content is a caller bug
    fingerprint: { type: String, required: true },
    lines: { type: [lineSchema], required: true },
    reference: {
      type: { type: String },
      id: { type: String },
    },
    // Set on the entry that undoes another one
    reversalOf: { type: Schema.Types.ObjectId, ref: "LedgerEntry", default: null },
    postedAt: { type: Date, required: true, default: () => new Date() },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
ledgerEntrySchema.index({ merchantId: 1, mode: 1, idempotencyKey: 1 }, { unique: true });
// An entry can be reversed once
ledgerEntrySchema.index(
  { reversalOf: 1 },
  { unique: true, partialFilterExpression: { reversalOf: { $type: "objectId" } } },
);
ledgerEntrySchema.index({ merchantId: 1, mode: 1, postedAt: -1 });

/** One line of an entry as it hit one account, with the account's balance right after it. */
export const ledgerPostingSchema = new Schema(
  {
    entryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry", required: true },
    accountId: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    direction: { type: String, enum: DIRECTIONS, required: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    postedAt: { type: Date, required: true },
  },
  { timestamps: false },
);
// Account statements: newest first, paginated by (postedAt, _id)
ledgerPostingSchema.index({ accountId: 1, postedAt: -1, _id: -1 });

// Entries and postings are append-only. Corrections are new, reversing entries.
for (const schema of [ledgerEntrySchema, ledgerPostingSchema]) {
  const refuse = () => {
    throw new Error("Ledger entries and postings are immutable; post a reversal instead");
  };
  for (const op of [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "replaceOne",
    "findOneAndReplace",
    "deleteOne",
    "deleteMany",
    "findOneAndDelete",
  ] as const) {
    schema.pre(op, refuse);
  }
}

export type LedgerAccount = InferSchemaType<typeof ledgerAccountSchema> & { _id: Types.ObjectId };
export type LedgerEntry = InferSchemaType<typeof ledgerEntrySchema> & { _id: Types.ObjectId };
export type LedgerPosting = InferSchemaType<typeof ledgerPostingSchema> & { _id: Types.ObjectId };

export type LedgerModels = {
  LedgerAccount: Model<LedgerAccount>;
  LedgerEntry: Model<LedgerEntry>;
  LedgerPosting: Model<LedgerPosting>;
};
