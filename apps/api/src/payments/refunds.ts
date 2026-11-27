import type { ClientSession } from "mongoose";

import { ApiError } from "../errors.js";
import { GatewayError, type RazorpayRefund } from "../gateway/razorpay.js";
import { ensureAccounts, postEntry } from "../ledger/service.js";
import { refundLines } from "../ledger/templates.js";
import type { Models } from "../models/index.js";
import type { CheckoutDeps } from "./checkout.js";
import { newId, refundedOf, type PaymentIntent, type Refund, type RefundStatus } from "./models.js";
import { intentObject, refundJson as refundObject } from "./serialize.js";

/**
 * Refunds, safe under concurrency and partial failure.
 *
 * Creating one is a single transaction that:
 *   1. reserves the amount on the payment with one conditional update
 *      (`amountRefunded <= amount - refund`), so two refunds racing for the last rupee can't
 *      both win: MongoDB applies them one at a time, and the second no longer matches;
 *   2. takes it out of the merchant's balance in the ledger (which also refuses to go
 *      negative);
 *   3. records the refund and a `refund.created` event.
 * Only then is Razorpay asked to send the money. Its answer finishes the refund, or, if it
 * refuses, a compensating transaction releases the reservation and posts a reversing ledger
 * entry. Ledger entries are never edited.
 *
 * If our process dies between committing and calling Razorpay, the refund stays `pending`
 * with no gateway id. The reconciler first looks for it at Razorpay by our refund id (in the
 * refund's notes), and only creates it if it really isn't there, so a retry can never refund
 * a customer twice.
 */

export type RefundDeps = CheckoutDeps;

const CLOSED_STATUSES: RefundStatus[] = ["succeeded", "failed"];

async function recordEvent(
  models: Models,
  session: ClientSession,
  refund: Refund,
  type: string,
  extra: Record<string, unknown> = {},
  object: Record<string, unknown> = refundObject(refund),
): Promise<void> {
  await models.PaymentEvent.create(
    [
      {
        merchantId: refund.merchantId,
        mode: refund.mode,
        type,
        paymentIntentId: refund.paymentIntentId,
        data: {
          refund_id: refund._id,
          status: refund.status,
          amount: refund.amount,
          currency: refund.currency,
          ...extra,
          object,
        },
      },
    ],
    { session },
  );
}

/**
 * Our fee share that goes back with a refund: proportional, rounded down, and the refund that
 * completes the full amount returns whatever is left, so a fully refunded payment has returned
 * exactly its whole fee.
 */
async function feeShare(
  models: Models,
  session: ClientSession,
  intent: PaymentIntent,
  amount: number,
  refundedAfter: number,
): Promise<number> {
  const fee = intent.fee ?? 0;
  if (fee === 0) return 0;
  if (refundedAfter < intent.amount) return Math.floor((fee * amount) / intent.amount);
  const earlier = await models.Refund.aggregate<{ total: number }>([
    { $match: { paymentIntentId: intent._id, status: { $in: ["pending", "succeeded"] } } },
    { $group: { _id: null, total: { $sum: "$feeReturned" } } },
  ]).session(session);
  return fee - (earlier[0]?.total ?? 0);
}

export type RefundInput = {
  amount?: number;
  reason: Refund["reason"];
  note?: string;
};

export async function createRefund(
  deps: RefundDeps,
  intentId: string,
  input: RefundInput,
): Promise<Refund> {
  const intent = await deps.models.PaymentIntent.findById(intentId).lean<PaymentIntent>();
  if (!intent) throw new ApiError(404, "not_found", "Payment intent not found");
  if (intent.status !== "succeeded") {
    throw new ApiError(
      409,
      "invalid_state",
      `A payment that is ${intent.status} can't be refunded`,
    );
  }
  const amount = input.amount ?? intent.amount - refundedOf(intent);
  if (amount <= 0) {
    throw new ApiError(409, "already_refunded", "This payment has already been fully refunded");
  }
  // A live payment always went through Razorpay; a test payment may have been completed
  // with test_actions, and then there's nothing at a gateway to refund
  const provider = intent.gateway?.paymentId ? "razorpay" : "none";
  if (provider === "razorpay") gatewayOrFail(deps, intent);
  await ensureAccounts(deps.models, intent.merchantId, intent.mode, intent.currency);

  const refundId = newId("re");
  let created: Refund | undefined;
  await deps.mongo.transaction(async (session) => {
    // 1. Reserve. Matches only while the rest of the payment covers this refund.
    const reserved = await deps.models.PaymentIntent.findOneAndUpdate(
      {
        _id: intentId,
        status: "succeeded",
        $or: [
          { amountRefunded: { $lte: intent.amount - amount } },
          // Payments from before refunds existed: nothing refunded yet
          { amountRefunded: { $exists: false } },
        ],
      },
      { $inc: { amountRefunded: amount } },
      { session, returnDocument: "after" },
    ).lean<PaymentIntent>();
    if (!reserved) {
      const current = await deps.models.PaymentIntent.findById(intentId)
        .session(session)
        .lean<PaymentIntent>();
      const left = current ? current.amount - refundedOf(current) : 0;
      throw new ApiError(
        422,
        "amount_too_large",
        `Only ${left} paise of this payment can still be refunded`,
        { refundable: left },
      );
    }
    const feeReturned = await feeShare(
      deps.models,
      session,
      intent,
      amount,
      reserved.amountRefunded,
    );

    // 2. Take it out of the merchant's balance (refused if the balance can't cover it)
    const { entry } = await postEntry(
      deps,
      {
        merchantId: intent.merchantId,
        mode: intent.mode,
        currency: intent.currency,
        description: `Refund ${refundId} of payment ${intent._id}`,
        idempotencyKey: `refund:${refundId}`,
        lines: refundLines(amount, feeReturned),
        reference: { type: "refund", id: refundId },
      },
      { session },
    );

    // 3. The refund itself, and its event (the transactional outbox)
    const [doc] = await deps.models.Refund.create(
      [
        {
          _id: refundId,
          merchantId: intent.merchantId,
          mode: intent.mode,
          paymentIntentId: intent._id,
          amount,
          currency: intent.currency,
          feeReturned,
          reason: input.reason,
          note: input.note ?? null,
          status: "pending",
          gateway: { provider, refundId: null, checkedAt: null },
          ledgerEntryId: entry._id,
        },
      ],
      { session },
    );
    created = (doc as unknown as { toObject: () => Refund }).toObject();
    await recordEvent(deps.models, session, created, "refund.created");
  });
  const refund = created as Refund;

  if (provider === "none") return succeedRefund(deps, refund._id, {});
  return sendToGateway(deps, refund, intent);
}

function gatewayOrFail(deps: RefundDeps, intent: PaymentIntent) {
  const client = deps.gateways[intent.mode];
  if (!client) {
    throw new ApiError(
      503,
      "gateway_not_configured",
      `${intent.mode === "live" ? "Live" : "Test"} payments aren't set up on this server`,
    );
  }
  return client;
}

/** Asks Razorpay to refund, unless it already has this refund (found by our id in its notes). */
async function sendToGateway(
  deps: RefundDeps,
  refund: Refund,
  intent: PaymentIntent,
): Promise<Refund> {
  const client = gatewayOrFail(deps, intent);
  const paymentId = intent.gateway?.paymentId as string;
  let result: RazorpayRefund;
  try {
    const existing = (await client.paymentRefunds(paymentId)).find(
      (r) => !Array.isArray(r.notes) && r.notes?.payguard_refund === refund._id,
    );
    result =
      existing ??
      (await client.createRefund(paymentId, {
        amount: refund.amount,
        receipt: refund._id,
        notes: { payguard_refund: refund._id, payment_intent: intent._id },
      }));
  } catch (err) {
    if (err instanceof GatewayError && err.retryable) {
      // Razorpay is unreachable: the refund stays pending, and the reconciler retries it
      deps.logger.warn({ err, refundId: refund._id }, "Refund not sent yet; will retry");
      await deps.models.Refund.updateOne(
        { _id: refund._id },
        { $set: { "gateway.checkedAt": new Date() } },
      );
      return reloadRefund(deps.models, refund._id);
    }
    if (err instanceof GatewayError) {
      // Razorpay refused it (e.g. the payment is too old to refund): give the money back
      return failRefund(deps, refund._id, err.message);
    }
    throw err;
  }
  return applyGatewayRefund(deps, refund._id, result);
}

/** Applies what Razorpay says about a refund. */
export async function applyGatewayRefund(
  deps: RefundDeps,
  refundId: string,
  gatewayRefund: RazorpayRefund,
): Promise<Refund> {
  if (gatewayRefund.status === "processed") {
    return succeedRefund(deps, refundId, { "gateway.refundId": gatewayRefund.id });
  }
  if (gatewayRefund.status === "failed") {
    await deps.models.Refund.updateOne(
      { _id: refundId, "gateway.refundId": null },
      { $set: { "gateway.refundId": gatewayRefund.id } },
    );
    return failRefund(deps, refundId, "The bank couldn't complete the refund");
  }
  await deps.models.Refund.updateOne(
    { _id: refundId },
    { $set: { "gateway.refundId": gatewayRefund.id, "gateway.checkedAt": new Date() } },
  );
  return reloadRefund(deps.models, refundId);
}

async function reloadRefund(models: Models, refundId: string): Promise<Refund> {
  const refund = await models.Refund.findById(refundId).lean<Refund>();
  if (!refund) throw new ApiError(404, "not_found", "Refund not found");
  return refund;
}

/** pending → succeeded. A no-op if something else finished it first. */
async function succeedRefund(
  deps: RefundDeps,
  refundId: string,
  set: Record<string, unknown>,
): Promise<Refund> {
  await deps.mongo.transaction(async (session) => {
    const done = await deps.models.Refund.findOneAndUpdate(
      { _id: refundId, status: "pending" },
      { $set: { ...set, status: "succeeded", succeededAt: new Date() } },
      { session, returnDocument: "after" },
    ).lean<Refund>();
    if (!done) return; // already succeeded or failed: nothing to do
    await recordEvent(deps.models, session, done, "refund.succeeded");
    // The last open refund of a fully refunded payment: announce that, too
    const intent = await deps.models.PaymentIntent.findById(done.paymentIntentId)
      .session(session)
      .lean<PaymentIntent>();
    if (
      intent &&
      refundedOf(intent) === intent.amount &&
      (await allRefundsSettled(deps.models, session, intent._id))
    ) {
      await recordEvent(
        deps.models,
        session,
        done,
        "payment_intent.refunded",
        { payment_amount: intent.amount },
        intentObject(intent),
      );
    }
  });
  return reloadRefund(deps.models, refundId);
}

async function allRefundsSettled(
  models: Models,
  session: ClientSession,
  intentId: string,
): Promise<boolean> {
  const open = await models.Refund.countDocuments({
    paymentIntentId: intentId,
    status: "pending",
  }).session(session);
  return open === 0;
}

/**
 * pending → failed, undoing the money: the reservation on the payment is released and a
 * reversing ledger entry gives the merchant their balance back. All in one transaction, and
 * only once: the conditional status change makes a second call a no-op.
 */
export async function failRefund(
  deps: RefundDeps,
  refundId: string,
  reason: string,
): Promise<Refund> {
  const refund = await reloadRefund(deps.models, refundId);
  if (CLOSED_STATUSES.includes(refund.status)) return refund;
  const original = await deps.models.LedgerEntry.findById(refund.ledgerEntryId).lean();
  if (!original) throw new Error(`Refund ${refundId} has no ledger entry`);

  await deps.mongo.transaction(async (session) => {
    const failed = await deps.models.Refund.findOneAndUpdate(
      { _id: refundId, status: "pending" },
      { $set: { status: "failed", failureReason: reason } },
      { session, returnDocument: "after" },
    ).lean<Refund>();
    if (!failed) return;
    await deps.models.PaymentIntent.updateOne(
      { _id: failed.paymentIntentId },
      { $inc: { amountRefunded: -failed.amount } },
      { session },
    );
    const { entry } = await postEntry(
      deps,
      {
        merchantId: original.merchantId,
        mode: original.mode,
        currency: original.currency,
        description: `Refund ${refundId} failed: reversed`,
        idempotencyKey: `reversal:${original._id.toString()}`,
        lines: original.lines.map((line) => ({
          account: line.accountCode,
          direction: line.direction === "debit" ? "credit" : "debit",
          amount: line.amount,
        })),
        reference: { type: "refund", id: refundId },
      },
      { session, reversalOf: original._id },
    );
    await deps.models.Refund.updateOne(
      { _id: refundId },
      { $set: { reversalEntryId: entry._id } },
      { session },
    );
    await recordEvent(deps.models, session, failed, "refund.failed", { failure_reason: reason });
  });
  return reloadRefund(deps.models, refundId);
}

/**
 * Brings a pending refund up to date with Razorpay: sends it if it was never sent, otherwise
 * reads its status. Used by the reconciler and by Razorpay's refund webhooks.
 */
export async function syncRefund(
  deps: RefundDeps,
  refundId: string,
  now = new Date(),
): Promise<Refund> {
  const refund = await reloadRefund(deps.models, refundId);
  if (refund.status !== "pending" || refund.gateway?.provider !== "razorpay") return refund;
  const intent = await deps.models.PaymentIntent.findById(
    refund.paymentIntentId,
  ).lean<PaymentIntent>();
  if (!intent) throw new Error(`Refund ${refundId} has no payment`);
  const gatewayRefundId = refund.gateway.refundId;
  if (!gatewayRefundId) return sendToGateway(deps, refund, intent);
  const client = gatewayOrFail(deps, intent);
  await deps.models.Refund.updateOne({ _id: refundId }, { $set: { "gateway.checkedAt": now } });
  return applyGatewayRefund(deps, refundId, await client.getRefund(gatewayRefundId));
}

/** Pending refunds not looked at for `afterSeconds`, oldest check first. */
export async function reconcileRefunds(
  deps: RefundDeps,
  options: { afterSeconds: number; batchSize?: number; now?: Date },
): Promise<{ checked: number; changed: number; errors: number }> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - options.afterSeconds * 1000);
  const due = await deps.models.Refund.find({
    status: "pending",
    "gateway.provider": "razorpay",
    updatedAt: { $lt: cutoff },
    $or: [{ "gateway.checkedAt": null }, { "gateway.checkedAt": { $lt: cutoff } }],
  })
    .sort({ "gateway.checkedAt": 1 })
    .limit(options.batchSize ?? 50)
    .lean<Refund[]>();
  const result = { checked: 0, changed: 0, errors: 0 };
  for (const refund of due) {
    result.checked += 1;
    try {
      const after = await syncRefund(deps, refund._id, now);
      if (after.status !== "pending") result.changed += 1;
    } catch (err) {
      result.errors += 1;
      deps.logger.warn({ err, refundId: refund._id }, "Reconciling a refund failed");
    }
  }
  return result;
}
