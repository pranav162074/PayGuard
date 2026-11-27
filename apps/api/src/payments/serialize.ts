/**
 * The public JSON shape of each object, in one place: API responses, and the snapshots that
 * events (and so merchant webhooks) carry.
 */
import { refundedOf, type PaymentIntent, type Refund } from "./models.js";

export function metadataOf(intent: PaymentIntent): Record<string, string> {
  const raw = intent.metadata as unknown as Map<string, string> | Record<string, string> | null;
  if (!raw) return {};
  return raw instanceof Map ? Object.fromEntries(raw) : { ...raw };
}

/** A payment intent without its client secret: what events and webhooks carry. */
export function intentObject(intent: PaymentIntent) {
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
    // Includes refunds still in progress
    amount_refunded: refundedOf(intent),
    refunded: refundedOf(intent) === intent.amount,
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

/** A payment intent as the API returns it to the merchant: with the client secret and link. */
export function intentJson(intent: PaymentIntent, checkoutUrl: string) {
  const checkoutOpen = intent.status === "requires_payment" || intent.status === "failed";
  return {
    ...intentObject(intent),
    // Give these to the customer's browser: the hosted page, or your own page using the
    // secret with GET /v1/checkout/{id}
    client_secret: intent.clientSecret,
    checkout_url: checkoutOpen
      ? `${checkoutUrl}/pay/${intent._id}?client_secret=${encodeURIComponent(intent.clientSecret)}`
      : null,
  };
}

export function refundJson(refund: Refund) {
  return {
    id: refund._id,
    object: "refund",
    payment_intent: refund.paymentIntentId,
    amount: refund.amount,
    currency: refund.currency,
    fee_returned: refund.feeReturned,
    reason: refund.reason,
    note: refund.note,
    status: refund.status,
    failure_reason: refund.failureReason,
    mode: refund.mode,
    gateway: {
      provider: refund.gateway?.provider ?? "none",
      refund_id: refund.gateway?.refundId ?? null,
    },
    ledger_entry_id: refund.ledgerEntryId?.toString() ?? null,
    reversal_entry_id: refund.reversalEntryId?.toString() ?? null,
    created_at: refund.createdAt,
    succeeded_at: refund.succeededAt,
  };
}
