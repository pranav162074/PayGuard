import type { ClientSession, Connection } from "mongoose";

import { ApiError } from "../errors.js";
import { feeFor } from "../ledger/money.js";
import { ensureAccounts, postEntry } from "../ledger/service.js";
import { captureLines } from "../ledger/templates.js";
import type { Models } from "../models/index.js";
import type { PaymentIntent } from "./models.js";
import { intentObject } from "./serialize.js";
import { sourcesOf, type PaymentStatus } from "./stateMachine.js";

export type PaymentDeps = { mongo: Connection; models: Models; feeBasisPoints: number };

function invalidState(intent: Pick<PaymentIntent, "status">, to: PaymentStatus): ApiError {
  return new ApiError(
    409,
    "invalid_state",
    `A payment that is ${intent.status} can't become ${to}`,
  );
}

async function recordEvent(
  models: Models,
  session: ClientSession,
  intent: PaymentIntent,
  type: string,
): Promise<void> {
  await models.PaymentEvent.create(
    [
      {
        merchantId: intent.merchantId,
        mode: intent.mode,
        type,
        paymentIntentId: intent._id,
        data: {
          status: intent.status,
          amount: intent.amount,
          currency: intent.currency,
          // What the merchant's webhook receives, as it was at this moment
          object: intentObject(intent),
        },
      },
    ],
    { session },
  );
}

/**
 * Moves an intent to a new status, inside the caller's transaction. A single conditional
 * update: it only matches while the intent is still in a state that may move to `to`, so two
 * concurrent changes (a webhook and a cancel, say) can't both apply.
 */
async function transition(
  models: Models,
  session: ClientSession,
  intentId: string,
  to: PaymentStatus,
  // Plain fields, or dotted paths into subdocuments like "gateway.paymentId"
  set: Record<string, unknown> = {},
): Promise<PaymentIntent> {
  const updated = await models.PaymentIntent.findOneAndUpdate(
    { _id: intentId, status: { $in: sourcesOf(to) } },
    { $set: { ...set, status: to }, $inc: { version: 1 } },
    { session, returnDocument: "after" },
  ).lean<PaymentIntent>();
  if (updated) return updated;
  const current = await models.PaymentIntent.findById(intentId).session(session).lean();
  if (!current) throw new ApiError(404, "not_found", "Payment intent not found");
  throw invalidState(current, to);
}

export async function createIntent(
  deps: PaymentDeps,
  fields: Omit<
    PaymentIntent,
    | "_id"
    | "status"
    | "version"
    | "createdAt"
    | "updatedAt"
    | "fee"
    | "failureReason"
    | "ledgerEntryId"
    | "succeededAt"
    | "canceledAt"
    | "clientSecret"
    | "gateway"
    | "amountRefunded"
  >,
): Promise<PaymentIntent> {
  let created: PaymentIntent | undefined;
  await deps.mongo.transaction(async (session) => {
    const [doc] = await deps.models.PaymentIntent.create(
      [{ ...fields, status: "requires_payment" }],
      { session },
    );
    if (!doc) throw new Error("Payment intent not created");
    created = doc.toObject();
    await recordEvent(deps.models, session, created, "payment_intent.created");
  });
  if (!created) throw new Error("Payment intent not created");
  return created;
}

export async function cancelIntent(deps: PaymentDeps, intentId: string): Promise<PaymentIntent> {
  let result: PaymentIntent | undefined;
  await deps.mongo.transaction(async (session) => {
    result = await transition(deps.models, session, intentId, "canceled", {
      canceledAt: new Date(),
    });
    await recordEvent(deps.models, session, result, "payment_intent.canceled");
  });
  return result as PaymentIntent;
}

/**
 * The customer has paid on the checkout and the gateway is finishing up (or we couldn't
 * reach it to find out yet). Webhooks or the reconciler move it on from here.
 */
export async function markProcessing(
  deps: PaymentDeps,
  intentId: string,
  set: Record<string, unknown> = {},
): Promise<PaymentIntent> {
  let result: PaymentIntent | undefined;
  await deps.mongo.transaction(async (session) => {
    result = await transition(deps.models, session, intentId, "processing", set);
    await recordEvent(deps.models, session, result, "payment_intent.processing");
  });
  return result as PaymentIntent;
}

export async function failIntent(
  deps: PaymentDeps,
  intentId: string,
  reason: string,
): Promise<PaymentIntent> {
  let result: PaymentIntent | undefined;
  await deps.mongo.transaction(async (session) => {
    result = await transition(deps.models, session, intentId, "failed", { failureReason: reason });
    await recordEvent(deps.models, session, result, "payment_intent.payment_failed");
  });
  return result as PaymentIntent;
}

/**
 * The money moment. In one transaction: the intent becomes succeeded, the capture is posted
 * to the ledger (receivable up, merchant balance up by the amount minus our fee, fee
 * revenue up), and an event is recorded. All three happen or none do: a payment can never
 * be "succeeded" without its ledger entry, or vice versa. Calling it twice is refused by the
 * state machine, and the ledger entry's idempotency key would refuse a second posting too.
 */
export async function succeedIntent(
  deps: PaymentDeps,
  intentId: string,
  // Extra fields to set with the status change, like the gateway's payment id
  set: Record<string, unknown> = {},
): Promise<PaymentIntent> {
  const intent = await deps.models.PaymentIntent.findById(intentId).lean<PaymentIntent>();
  if (!intent) throw new ApiError(404, "not_found", "Payment intent not found");
  if (!sourcesOf("succeeded").includes(intent.status)) throw invalidState(intent, "succeeded");
  const fee = feeFor(intent.amount, deps.feeBasisPoints);
  // Before the transaction: a transaction reads from a snapshot taken at its first read, so
  // accounts created inside it by another session wouldn't be visible to it
  await ensureAccounts(deps.models, intent.merchantId, intent.mode, intent.currency);

  let result: PaymentIntent | undefined;
  await deps.mongo.transaction(async (session) => {
    // The status change comes first: of two concurrent attempts, the second hits a write
    // conflict on this document, MongoDB retries its transaction, and the retry finds the
    // payment already succeeded (409) before it can post anything.
    result = await transition(deps.models, session, intentId, "succeeded", {
      ...set,
      fee,
      succeededAt: new Date(),
    });
    const { entry } = await postEntry(
      deps,
      {
        merchantId: intent.merchantId,
        mode: intent.mode,
        currency: intent.currency,
        description: `Payment ${intent._id}`,
        idempotencyKey: `capture:${intent._id}`,
        lines: captureLines(intent.amount, fee),
        reference: { type: "payment_intent", id: intent._id },
      },
      { session },
    );
    const linked = await deps.models.PaymentIntent.findOneAndUpdate(
      { _id: intentId },
      { $set: { ledgerEntryId: entry._id } },
      { session, returnDocument: "after" },
    ).lean<PaymentIntent>();
    if (!linked) throw new Error("Payment intent vanished mid-transaction");
    result = linked;
    await recordEvent(deps.models, session, result, "payment_intent.succeeded");
  });
  return result as PaymentIntent;
}
