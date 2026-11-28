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

/**
 * The gateway paid out. It settles the payments minus the refunds (`gross`, which clears that
 * much of the receivable), keeping its own fee and tax: the bank gets the rest, and the fee
 * is our expense. Without fees this is just receivable → bank.
 *
 * `gross` can be negative (a day with more refunds than payments): then the gateway takes
 * money back and the lines flip.
 */
export function settlementLines(gross: number, gatewayFees = 0): LineInput[] {
  const net = gross - gatewayFees;
  const lines: LineInput[] = [];
  if (net !== 0) {
    lines.push({ account: "bank", direction: net > 0 ? "debit" : "credit", amount: Math.abs(net) });
  }
  if (gatewayFees > 0) {
    lines.push({ account: "gateway_fees", direction: "debit", amount: gatewayFees });
  }
  if (gross !== 0) {
    lines.push({
      account: "gateway_receivable",
      direction: gross > 0 ? "credit" : "debit",
      amount: Math.abs(gross),
    });
  }
  return lines;
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
