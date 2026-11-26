import type { LineInput } from "./service.js";

/**
 * The entries the payment flows will post. Kept here, as pure functions, so the bookkeeping
 * for each event is defined (and tested) in one place.
 */

/** A captured payment: the gateway owes us the full amount; the merchant is owed it minus our fee. */
export function captureLines(amount: number, fee: number): LineInput[] {
  const lines: LineInput[] = [
    { account: "gateway_receivable", direction: "debit", amount },
    { account: "merchant_payable", direction: "credit", amount: amount - fee },
  ];
  if (fee > 0) lines.push({ account: "fee_revenue", direction: "credit", amount: fee });
  return lines;
}

/** The gateway paid out: the receivable becomes cash in the bank. */
export function settlementLines(amount: number): LineInput[] {
  return [
    { account: "bank", direction: "debit", amount },
    { account: "gateway_receivable", direction: "credit", amount },
  ];
}

/**
 * A refund comes out of the merchant's balance. The gateway pays the customer and deducts it
 * from what it owes us, so the receivable goes down (and can go negative: then we owe it).
 *
 * `feeReturned` is our share of the original fee that goes back with the refund: we don't
 * keep a fee on money that was returned, so it comes out of fee revenue instead of the
 * merchant's balance. That also means a merchant can always fully refund a payment they
 * haven't been paid out for.
 */
export function refundLines(amount: number, feeReturned = 0): LineInput[] {
  const lines: LineInput[] = [
    { account: "merchant_payable", direction: "debit", amount: amount - feeReturned },
    { account: "gateway_receivable", direction: "credit", amount },
  ];
  if (feeReturned > 0)
    lines.push({ account: "fee_revenue", direction: "debit", amount: feeReturned });
  return lines;
}
