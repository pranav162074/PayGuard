/**
 * Reconciliation: once a day, does Razorpay agree with us?
 *
 * Webhooks and the reconciler (payments/checkout.ts) keep each payment right as it happens.
 * This checks the day as a whole, from Razorpay's side, the way a finance team would:
 *
 * 1. **Payments.** Every payment Razorpay captured that day is matched to our payment intent
 *    (by payment id, else by order id): same status, same amount, same refunded total. A
 *    capture we missed is synced from Razorpay and recorded as fixed. Every payment we
 *    recorded as succeeded must be captured at Razorpay.
 * 2. **Settlements.** Razorpay's settlement report for the day lists each payment, refund and
 *    adjustment it paid out, and the bank transfer it was in. Each line is matched to ours;
 *    each settlement is split by merchant and posted to the ledger (receivable → bank, with
 *    Razorpay's fee as an expense), once, whatever the number of runs.
 * 3. **Ageing.** Live payments captured days ago and still in no settlement are flagged.
 *
 * Anything that doesn't match becomes a mismatch row: one per problem (a re-run finds the same
 * row), resolved automatically when a later run no longer finds it, or by a person with a note.
 * Running a day again is safe; it's how a fixed problem gets closed.
 */
import type { Types } from "mongoose";

import { ApiError } from "../errors.js";
import type { RazorpayPayment, RazorpayReconItem } from "../gateway/razorpay.js";
import { ensureAccounts, postEntry } from "../ledger/service.js";
import { settlementLines } from "../ledger/templates.js";
import type { KeyMode } from "../models/index.js";
import { syncIntent, type CheckoutDeps } from "../payments/checkout.js";
import { refundedOf, type PaymentIntent, type Refund } from "../payments/models.js";
import type { MismatchType, ReconciliationRun, ReconMismatch } from "./models.js";

/** Razorpay's day is India's: +05:30, no daylight saving. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A run that has said "running" this long has died; another may take the day over. */
const STALE_RUN_MS = 30 * 60 * 1000;

export type ReconDeps = CheckoutDeps;

export type ReconOptions = {
  mode: KeyMode;
  /** The day, YYYY-MM-DD in India time */
  date: string;
  now?: Date;
  /** Flag captured payments not settled after this many days (live mode; test never settles) */
  overdueDays?: number;
  checkOverdue?: boolean;
};

export function dayWindow(date: string): {
  from: number;
  to: number;
  year: number;
  month: number;
  day: number;
} {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new ApiError(422, "invalid_date", "The date must be YYYY-MM-DD");
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const start = Date.UTC(year, month - 1, day) - IST_OFFSET_MS;
  if (Number.isNaN(start) || new Date(start + IST_OFFSET_MS).getUTCDate() !== day) {
    throw new ApiError(422, "invalid_date", "That date doesn't exist");
  }
  return { from: start / 1000, to: (start + DAY_MS) / 1000, year, month, day };
}

/** Yesterday in India: the day the nightly run checks. */
export function previousIstDay(now: Date): string {
  return new Date(now.getTime() + IST_OFFSET_MS - DAY_MS).toISOString().slice(0, 10);
}

type Found = {
  type: MismatchType;
  entityType: "payment" | "refund" | "settlement" | "adjustment";
  entityId: string;
  merchantId: Types.ObjectId | null;
  paymentIntentId?: string | null;
  expected?: unknown;
  actual?: unknown;
  message: string;
  /** The run fixed it itself */
  fixed?: boolean;
};

type Summary = {
  merchantId: Types.ObjectId;
  matched: number;
  mismatches: number;
  gatewayAmount: number;
  ledgerAmount: number;
  settledNet: number;
};

type Share = {
  merchantId: Types.ObjectId;
  payments: number;
  refunds: number;
  fees: number;
  tax: number;
  lines: number;
  ledgerEntryId: Types.ObjectId | null;
};

const rupees = (paise: number) => `₹${(paise / 100).toFixed(2)}`;

class Collector {
  found = new Map<string, Found>();
  summaries = new Map<string, Summary>();

  summary(merchantId: Types.ObjectId): Summary {
    const key = merchantId.toString();
    let s = this.summaries.get(key);
    if (!s) {
      s = {
        merchantId,
        matched: 0,
        mismatches: 0,
        gatewayAmount: 0,
        ledgerAmount: 0,
        settledNet: 0,
      };
      this.summaries.set(key, s);
    }
    return s;
  }

  add(found: Found): void {
    const key = `${found.type}:${found.entityId}`;
    if (this.found.has(key)) return;
    this.found.set(key, found);
    if (found.merchantId && !found.fixed) this.summary(found.merchantId).mismatches += 1;
  }
}

async function claimRun(deps: ReconDeps, mode: KeyMode, date: string, now: Date) {
  try {
    return await deps.models.ReconciliationRun.findOneAndUpdate(
      {
        mode,
        date,
        $or: [
          { status: { $ne: "running" } },
          { startedAt: { $lt: new Date(now.getTime() - STALE_RUN_MS) } },
        ],
      },
      {
        $set: { status: "running", startedAt: now, finishedAt: null, error: null },
        $inc: { attempts: 1 },
      },
      { upsert: true, returnDocument: "after" },
    ).lean<ReconciliationRun>();
  } catch (err) {
    // The upsert hit the unique (mode, date) index: a live run holds the day
    if ((err as { code?: number }).code === 11000) {
      throw new ApiError(409, "already_running", `Reconciliation of ${date} is already running`);
    }
    throw err;
  }
}

async function intentsByGateway(
  deps: ReconDeps,
  mode: KeyMode,
  paymentIds: string[],
  orderIds: string[],
): Promise<{ byPayment: Map<string, PaymentIntent>; byOrder: Map<string, PaymentIntent> }> {
  const rows = await deps.models.PaymentIntent.find({
    mode,
    $or: [{ "gateway.paymentId": { $in: paymentIds } }, { "gateway.orderId": { $in: orderIds } }],
  }).lean<PaymentIntent[]>();
  const byPayment = new Map<string, PaymentIntent>();
  const byOrder = new Map<string, PaymentIntent>();
  for (const row of rows) {
    if (row.gateway?.paymentId) byPayment.set(row.gateway.paymentId, row);
    if (row.gateway?.orderId) byOrder.set(row.gateway.orderId, row);
  }
  return { byPayment, byOrder };
}

const isCaptured = (p: RazorpayPayment) => p.status === "captured" || p.status === "refunded";

async function reconcilePayments(
  deps: ReconDeps,
  options: ReconOptions,
  now: Date,
  c: Collector,
): Promise<{ gatewayPayments: number; matched: number }> {
  const client = deps.gateways[options.mode];
  if (!client) throw new Error("No gateway");
  const { from, to } = dayWindow(options.date);
  const captured = (await client.listPayments(from, to)).filter(isCaptured);
  const { byPayment, byOrder } = await intentsByGateway(
    deps,
    options.mode,
    captured.map((p) => p.id),
    captured.map((p) => p.order_id).filter((o): o is string => o !== null),
  );
  let matched = 0;

  for (const payment of captured) {
    let intent =
      byPayment.get(payment.id) ?? (payment.order_id ? byOrder.get(payment.order_id) : undefined);
    if (!intent) {
      c.add({
        type: "unknown_at_gateway",
        entityType: "payment",
        entityId: payment.id,
        merchantId: null,
        actual: { amount: payment.amount, order_id: payment.order_id, status: payment.status },
        message: `Razorpay captured ${rupees(payment.amount)} (${payment.id}) that matches no payment of ours`,
      });
      continue;
    }
    const summary = c.summary(intent.merchantId);
    summary.gatewayAmount += payment.amount;
    let ok = true;

    if (intent.status !== "succeeded") {
      const before = intent.status;
      // Razorpay is the truth for whether money moved: ask it, through the normal path
      intent = await syncIntent(deps, intent._id, { now });
      if (intent.status === "succeeded") {
        c.add({
          type: "late_capture",
          entityType: "payment",
          entityId: payment.id,
          merchantId: intent.merchantId,
          paymentIntentId: intent._id,
          expected: { status: "succeeded" },
          actual: { status: before },
          message: `Captured at Razorpay but ${before} here; synced, now succeeded`,
          fixed: true,
        });
      } else {
        ok = false;
        c.add({
          type: "status_mismatch",
          entityType: "payment",
          entityId: payment.id,
          merchantId: intent.merchantId,
          paymentIntentId: intent._id,
          expected: { status: "succeeded" },
          actual: { status: intent.status },
          message: `Captured at Razorpay, but ${intent.status} here even after syncing`,
        });
      }
    }
    if (intent.status === "succeeded") summary.ledgerAmount += intent.amount;
    if (intent.amount !== payment.amount) {
      ok = false;
      c.add({
        type: "amount_mismatch",
        entityType: "payment",
        entityId: payment.id,
        merchantId: intent.merchantId,
        paymentIntentId: intent._id,
        expected: { amount: intent.amount },
        actual: { amount: payment.amount },
        message: `Razorpay captured ${rupees(payment.amount)}; the payment was for ${rupees(intent.amount)}`,
      });
    }
    const gatewayRefunded = payment.amount_refunded ?? 0;
    if (gatewayRefunded !== refundedOf(intent)) {
      ok = false;
      c.add({
        type: "refund_mismatch",
        entityType: "payment",
        entityId: payment.id,
        merchantId: intent.merchantId,
        paymentIntentId: intent._id,
        expected: { amount_refunded: refundedOf(intent) },
        actual: { amount_refunded: gatewayRefunded },
        message: `Razorpay has refunded ${rupees(gatewayRefunded)}; we have ${rupees(refundedOf(intent))}`,
      });
    }
    if (ok) {
      matched += 1;
      summary.matched += 1;
    }
  }

  // The other direction: what we say succeeded must be captured at Razorpay
  const seen = new Set(captured.map((p) => p.id));
  const ours = await deps.models.PaymentIntent.find({
    mode: options.mode,
    status: "succeeded",
    "gateway.provider": "razorpay",
    succeededAt: { $gte: new Date(from * 1000), $lt: new Date(to * 1000) },
  }).lean<PaymentIntent[]>();
  for (const intent of ours) {
    const paymentId = intent.gateway?.paymentId;
    if (paymentId && seen.has(paymentId)) continue;
    // Created just before midnight, captured after: it's in the neighbouring day's list.
    // Ask Razorpay about this one order before calling it missing.
    const atGateway = intent.gateway?.orderId
      ? await client.orderPayments(intent.gateway.orderId)
      : [];
    const capture = atGateway.find((p) => isCaptured(p) && (!paymentId || p.id === paymentId));
    const summary = c.summary(intent.merchantId);
    summary.ledgerAmount += intent.amount;
    if (capture) {
      summary.gatewayAmount += capture.amount;
      summary.matched += 1;
      matched += 1;
      continue;
    }
    c.add({
      type: "missing_at_gateway",
      entityType: "payment",
      entityId: paymentId ?? intent._id,
      merchantId: intent.merchantId,
      paymentIntentId: intent._id,
      expected: { status: "captured", amount: intent.amount },
      actual: { payments: atGateway.map((p) => ({ id: p.id, status: p.status })) },
      message: `Succeeded here for ${rupees(intent.amount)}, but Razorpay has no captured payment for it`,
    });
  }
  return { gatewayPayments: captured.length, matched };
}

async function reconcileSettlements(
  deps: ReconDeps,
  options: ReconOptions,
  c: Collector,
): Promise<{ settlements: number; lines: number }> {
  const client = deps.gateways[options.mode];
  if (!client) throw new Error("No gateway");
  const { year, month, day } = dayWindow(options.date);
  const items = (await client.settlementRecon(year, month, day)).filter(
    (i) => i.settled && i.settlement_id,
  );
  const paymentItems = items.filter((i) => i.type === "payment");
  const { byPayment, byOrder } = await intentsByGateway(
    deps,
    options.mode,
    paymentItems.map((i) => i.entity_id),
    paymentItems.map((i) => i.order_id).filter((o): o is string => o !== null),
  );
  const refunds = await deps.models.Refund.find({
    mode: options.mode,
    "gateway.refundId": { $in: items.filter((i) => i.type === "refund").map((i) => i.entity_id) },
  }).lean<Refund[]>();
  const refundsById = new Map(refunds.map((r) => [r.gateway?.refundId as string, r]));

  const bySettlement = new Map<string, RazorpayReconItem[]>();
  for (const item of items) {
    const list = bySettlement.get(item.settlement_id as string) ?? [];
    list.push(item);
    bySettlement.set(item.settlement_id as string, list);
  }

  for (const [settlementId, lines] of bySettlement) {
    const shares = new Map<string, Share>();
    const share = (merchantId: Types.ObjectId): Share => {
      const key = merchantId.toString();
      let s = shares.get(key);
      if (!s) {
        s = { merchantId, payments: 0, refunds: 0, fees: 0, tax: 0, lines: 0, ledgerEntryId: null };
        shares.set(key, s);
      }
      return s;
    };
    const settledAt = new Date((lines[0]?.settled_at ?? Date.now() / 1000) * 1000);

    for (const item of lines) {
      if (item.type === "payment") {
        const intent =
          byPayment.get(item.entity_id) ?? (item.order_id ? byOrder.get(item.order_id) : undefined);
        if (!intent) {
          c.add({
            type: "unknown_at_gateway",
            entityType: "payment",
            entityId: item.entity_id,
            merchantId: null,
            actual: { amount: item.amount, settlement_id: settlementId },
            message: `Settlement ${settlementId} pays out ${rupees(item.amount)} for ${item.entity_id}, which matches no payment of ours`,
          });
          continue;
        }
        if (item.amount !== intent.amount) {
          c.add({
            type: "settlement_amount_mismatch",
            entityType: "payment",
            entityId: item.entity_id,
            merchantId: intent.merchantId,
            paymentIntentId: intent._id,
            expected: { amount: intent.amount },
            actual: { amount: item.amount, settlement_id: settlementId },
            message: `Settled as ${rupees(item.amount)}; the payment was for ${rupees(intent.amount)}`,
          });
        }
        const s = share(intent.merchantId);
        s.payments += item.amount;
        s.fees += item.fee;
        s.tax += item.tax;
        s.lines += 1;
        await deps.models.PaymentIntent.updateOne(
          { _id: intent._id },
          { $set: { "gateway.settlementId": settlementId, "gateway.settledAt": settledAt } },
        );
      } else if (item.type === "refund") {
        const refund = refundsById.get(item.entity_id);
        if (!refund) {
          c.add({
            type: "unknown_at_gateway",
            entityType: "refund",
            entityId: item.entity_id,
            merchantId: null,
            actual: { amount: item.amount, settlement_id: settlementId },
            message: `Settlement ${settlementId} deducts a refund (${item.entity_id}) we have no record of`,
          });
          continue;
        }
        const s = share(refund.merchantId);
        s.refunds += item.amount;
        s.lines += 1;
      } else {
        c.add({
          type: "adjustment",
          entityType: "adjustment",
          entityId: item.entity_id,
          merchantId: null,
          actual: {
            type: item.type,
            credit: item.credit,
            debit: item.debit,
            settlement_id: settlementId,
          },
          message: `Settlement ${settlementId} has a ${item.type} line (${rupees(item.credit - item.debit)}): check it in the Razorpay dashboard`,
        });
      }
    }

    // One ledger entry per merchant per settlement, whatever the number of runs
    for (const s of shares.values()) {
      const gross = s.payments - s.refunds;
      const fees = s.fees + s.tax;
      if (gross === 0 && fees === 0) continue;
      try {
        await ensureAccounts(deps.models, s.merchantId, options.mode, "INR");
        const { entry } = await postEntry(deps, {
          merchantId: s.merchantId,
          mode: options.mode,
          currency: "INR",
          description: `Razorpay settlement ${settlementId}`,
          idempotencyKey: `settlement:${settlementId}`,
          lines: settlementLines(gross, fees),
          reference: { type: "settlement", id: settlementId },
        });
        s.ledgerEntryId = entry._id;
        c.summary(s.merchantId).settledNet += gross - fees;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        c.add({
          type: "ledger_rejected",
          entityType: "settlement",
          entityId: `${settlementId}:${s.merchantId.toString()}`,
          merchantId: s.merchantId,
          expected: { gross, fees },
          message: `Settlement ${settlementId} couldn't be posted: ${err.message}`,
        });
      }
    }

    await deps.models.Settlement.updateOne(
      { _id: settlementId },
      {
        $set: {
          mode: options.mode,
          utr: lines.find((l) => l.settlement_utr)?.settlement_utr ?? null,
          settledAt,
          date: options.date,
          amount: lines.reduce((sum, l) => sum + l.credit - l.debit, 0),
          fees: lines.reduce((sum, l) => sum + l.fee, 0),
          tax: lines.reduce((sum, l) => sum + l.tax, 0),
          lines: lines.length,
          merchants: [...shares.values()].map((s) => ({
            merchantId: s.merchantId,
            payments: s.payments,
            refunds: s.refunds,
            gross: s.payments - s.refunds,
            fees: s.fees,
            tax: s.tax,
            net: s.payments - s.refunds - s.fees - s.tax,
            lines: s.lines,
            ledgerEntryId: s.ledgerEntryId,
          })),
        },
      },
      { upsert: true },
    );
  }
  return { settlements: bySettlement.size, lines: items.length };
}

async function checkOverdue(deps: ReconDeps, options: ReconOptions, now: Date, c: Collector) {
  const days = options.overdueDays ?? 3;
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const overdue = await deps.models.PaymentIntent.find({
    mode: options.mode,
    status: "succeeded",
    "gateway.provider": "razorpay",
    "gateway.settlementId": null,
    // Old enough to be late; recent enough to still be worth chasing
    succeededAt: { $lt: cutoff, $gte: new Date(now.getTime() - 60 * DAY_MS) },
  }).lean<PaymentIntent[]>();
  for (const intent of overdue) {
    c.add({
      type: "settlement_overdue",
      entityType: "payment",
      entityId: intent.gateway?.paymentId ?? intent._id,
      merchantId: intent.merchantId,
      paymentIntentId: intent._id,
      expected: { settled_within_days: days },
      actual: { succeeded_at: intent.succeededAt },
      message: `Captured ${Math.floor((now.getTime() - (intent.succeededAt?.getTime() ?? 0)) / DAY_MS)} days ago and not settled yet`,
    });
  }
}

async function saveMismatches(
  deps: ReconDeps,
  run: ReconciliationRun,
  c: Collector,
  now: Date,
): Promise<{ open: number; fixed: number; resolved: number }> {
  const { models } = deps;
  let open = 0;
  let fixed = 0;
  for (const f of c.found.values()) {
    const existing = await models.ReconMismatch.findOne({
      mode: run.mode,
      type: f.type,
      entityId: f.entityId,
    }).lean<ReconMismatch>();
    // A person closed it: they've seen it, don't reopen it every night
    if (existing?.resolution === "manual") continue;
    const resolved = f.fixed
      ? { status: "resolved", resolution: "auto", resolvedAt: now, note: "Fixed by the run" }
      : { status: "open", resolution: null, resolvedAt: null, note: null };
    await models.ReconMismatch.updateOne(
      { mode: run.mode, type: f.type, entityId: f.entityId },
      {
        $set: {
          runId: run._id,
          date: run.date,
          merchantId: f.merchantId,
          entityType: f.entityType,
          paymentIntentId: f.paymentIntentId ?? null,
          expected: f.expected ?? null,
          actual: f.actual ?? null,
          message: f.message,
          ...resolved,
        },
      },
      { upsert: true },
    );
    if (f.fixed) fixed += 1;
    else open += 1;
  }

  // Found last time this day was run, not this time: it was fixed meanwhile
  const keys = new Set(c.found.keys());
  const stale = await models.ReconMismatch.find({
    mode: run.mode,
    date: run.date,
    status: "open",
  }).lean<ReconMismatch[]>();
  const gone = stale.filter((m) => !keys.has(`${m.type}:${m.entityId}`)).map((m) => m._id);
  // Overdue payments that have since been settled, whichever day flagged them
  const settled = await models.ReconMismatch.find({
    mode: run.mode,
    type: "settlement_overdue",
    status: "open",
  }).lean<ReconMismatch[]>();
  for (const m of settled) {
    const intent = m.paymentIntentId
      ? await models.PaymentIntent.findById(m.paymentIntentId).lean<PaymentIntent>()
      : null;
    if (intent?.gateway?.settlementId) gone.push(m._id);
  }
  const result = await models.ReconMismatch.updateMany(
    { _id: { $in: gone }, status: "open" },
    {
      $set: {
        status: "resolved",
        resolution: "auto",
        resolvedAt: now,
        note: "No longer found by a later run",
      },
    },
  );
  return { open, fixed, resolved: result.modifiedCount };
}

/** Reconciles one day in one mode. Safe to run again: that's how fixes get confirmed. */
export async function runReconciliation(
  deps: ReconDeps,
  options: ReconOptions,
): Promise<ReconciliationRun> {
  const now = options.now ?? new Date();
  dayWindow(options.date); // validate first
  if (!deps.gateways[options.mode]) {
    throw new ApiError(503, "gateway_not_configured", `No Razorpay ${options.mode} keys`);
  }
  const run = await claimRun(deps, options.mode, options.date, now);
  const c = new Collector();
  try {
    const payments = await reconcilePayments(deps, options, now, c);
    const settlements = await reconcileSettlements(deps, options, c);
    if (options.checkOverdue ?? options.mode === "live") await checkOverdue(deps, options, now, c);
    const saved = await saveMismatches(deps, run, c, now);
    const finished = await deps.models.ReconciliationRun.findOneAndUpdate(
      { _id: run._id },
      {
        $set: {
          status: "completed",
          finishedAt: new Date(),
          counts: {
            gatewayPayments: payments.gatewayPayments,
            matched: payments.matched,
            settlements: settlements.settlements,
            settlementLines: settlements.lines,
            mismatches: saved.open,
            autoFixed: saved.fixed,
            resolvedSinceLastRun: saved.resolved,
          },
          merchants: [...c.summaries.values()],
        },
      },
      { returnDocument: "after" },
    ).lean<ReconciliationRun>();
    deps.logger.info(
      { mode: options.mode, date: options.date, ...payments, ...settlements, ...saved },
      "Reconciliation finished",
    );
    return finished as ReconciliationRun;
  } catch (err) {
    await deps.models.ReconciliationRun.updateOne(
      { _id: run._id },
      { $set: { status: "failed", finishedAt: new Date(), error: (err as Error).message } },
    );
    deps.logger.error({ err, mode: options.mode, date: options.date }, "Reconciliation failed");
    throw err;
  }
}
