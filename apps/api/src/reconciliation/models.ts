import { Schema, type InferSchemaType, type Model } from "mongoose";

import { KEY_MODES } from "../models/constants.js";
import { newId } from "../payments/models.js";

/**
 * What can disagree between Razorpay and us. Each is one row a person can look into; the
 * run fixes what it safely can by itself ("late_capture") and leaves the rest open.
 */
export const MISMATCH_TYPES = [
  // Razorpay captured it; we hadn't recorded it as succeeded. Synced, so fixed by the run.
  "late_capture",
  // Razorpay captured it; we have it in another state even after asking Razorpay again
  "status_mismatch",
  // Same payment, different amount
  "amount_mismatch",
  // Razorpay's refunded total for a payment differs from ours
  "refund_mismatch",
  // We recorded a successful Razorpay payment that Razorpay doesn't have as captured
  "missing_at_gateway",
  // A Razorpay payment, refund or settlement line we can't match to anything of ours
  "unknown_at_gateway",
  // Razorpay settled a payment for a different amount than it was for
  "settlement_amount_mismatch",
  // Captured over SETTLEMENT_OVERDUE_DAYS ago and still not in any settlement
  "settlement_overdue",
  // Razorpay adjusted the settlement (a chargeback, a correction): always needs a look
  "adjustment",
  // The settlement couldn't be posted to the ledger (it would take the bank negative)
  "ledger_rejected",
] as const;
export type MismatchType = (typeof MISMATCH_TYPES)[number];

const merchantSummary = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    matched: { type: Number, required: true, default: 0 },
    mismatches: { type: Number, required: true, default: 0 },
    // Captured payments in the day, per Razorpay and per our ledger, in paise
    gatewayAmount: { type: Number, required: true, default: 0 },
    ledgerAmount: { type: Number, required: true, default: 0 },
    // Paid out to the bank this day, net of Razorpay's fees and refunds
    settledNet: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

/** One day's reconciliation, per mode. Running a day again updates the same run. */
export const reconciliationRunSchema = new Schema(
  {
    _id: { type: String, default: () => newId("recon") },
    mode: { type: String, enum: KEY_MODES, required: true },
    // The day reconciled, in India time (Razorpay's): YYYY-MM-DD
    date: { type: String, required: true },
    status: { type: String, enum: ["running", "completed", "failed"], required: true },
    attempts: { type: Number, required: true, default: 1 },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    error: { type: String, default: null },
    counts: {
      gatewayPayments: { type: Number, default: 0 },
      matched: { type: Number, default: 0 },
      settlements: { type: Number, default: 0 },
      settlementLines: { type: Number, default: 0 },
      mismatches: { type: Number, default: 0 },
      autoFixed: { type: Number, default: 0 },
      resolvedSinceLastRun: { type: Number, default: 0 },
    },
    merchants: { type: [merchantSummary], default: [] },
  },
  { timestamps: true },
);
reconciliationRunSchema.index({ mode: 1, date: 1 }, { unique: true });
reconciliationRunSchema.index({ "merchants.merchantId": 1, date: -1 });

export const reconMismatchSchema = new Schema(
  {
    _id: { type: String, default: () => newId("mm") },
    runId: { type: String, required: true },
    mode: { type: String, enum: KEY_MODES, required: true },
    date: { type: String, required: true },
    // null when the line can't be traced to a merchant (unknown at gateway)
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", default: null },
    type: { type: String, enum: MISMATCH_TYPES, required: true },
    // What it's about: a Razorpay payment, refund or settlement id
    entityType: { type: String, enum: ["payment", "refund", "settlement", "adjustment"] },
    entityId: { type: String, required: true },
    paymentIntentId: { type: String, default: null },
    expected: { type: Schema.Types.Mixed, default: null },
    actual: { type: Schema.Types.Mixed, default: null },
    message: { type: String, required: true },
    status: { type: String, enum: ["open", "resolved"], required: true, default: "open" },
    // auto: the run fixed it, or a later run no longer found it; manual: a person closed it
    resolution: { type: String, enum: ["auto", "manual", null], default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    note: { type: String, default: null },
  },
  { timestamps: true },
);
// The same problem found again (by a re-run, or the next night) is the same row
reconMismatchSchema.index({ mode: 1, type: 1, entityId: 1 }, { unique: true });
reconMismatchSchema.index({ merchantId: 1, status: 1, createdAt: -1 });
reconMismatchSchema.index({ runId: 1 });

const settlementShare = new Schema(
  {
    merchantId: { type: Schema.Types.ObjectId, ref: "Merchant", required: true },
    payments: { type: Number, required: true },
    refunds: { type: Number, required: true },
    // Payments minus refunds: what clears from the receivable
    gross: { type: Number, required: true },
    fees: { type: Number, required: true },
    tax: { type: Number, required: true },
    net: { type: Number, required: true },
    lines: { type: Number, required: true },
    ledgerEntryId: { type: Schema.Types.ObjectId, ref: "LedgerEntry", default: null },
  },
  { _id: false },
);

/** A bank transfer from Razorpay, split by the merchant whose payments it covers. */
export const settlementSchema = new Schema(
  {
    // Razorpay's settlement id (setl_...)
    _id: { type: String, required: true },
    mode: { type: String, enum: KEY_MODES, required: true },
    utr: { type: String, default: null },
    settledAt: { type: Date, required: true },
    date: { type: String, required: true },
    amount: { type: Number, required: true },
    fees: { type: Number, required: true },
    tax: { type: Number, required: true },
    lines: { type: Number, required: true },
    merchants: { type: [settlementShare], default: [] },
  },
  { timestamps: true },
);
settlementSchema.index({ "merchants.merchantId": 1, settledAt: -1 });

export type ReconciliationRun = InferSchemaType<typeof reconciliationRunSchema> & { _id: string };
export type ReconMismatch = InferSchemaType<typeof reconMismatchSchema> & { _id: string };
export type Settlement = InferSchemaType<typeof settlementSchema> & { _id: string };

export type ReconciliationModels = {
  ReconciliationRun: Model<ReconciliationRun>;
  ReconMismatch: Model<ReconMismatch>;
  Settlement: Model<Settlement>;
};
