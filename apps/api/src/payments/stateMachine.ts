/**
 * The life of a payment intent:
 *
 *   requires_payment ──▶ processing ──▶ succeeded
 *          │                  │
 *          │                  └──▶ failed ──▶ processing (the customer tries again)
 *          └──▶ canceled
 *
 * Every change goes through transition(), which only applies it if the intent is still in
 * a state that allows it. Anything else (a late webhook, a double click) is refused.
 */
export const PAYMENT_STATUSES = [
  "requires_payment",
  "processing",
  "succeeded",
  "failed",
  "canceled",
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  requires_payment: ["processing", "succeeded", "failed", "canceled"],
  processing: ["succeeded", "failed"],
  failed: ["processing", "succeeded", "canceled"],
  succeeded: [],
  canceled: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** The states a payment can move to `to` from. */
export function sourcesOf(to: PaymentStatus): PaymentStatus[] {
  return PAYMENT_STATUSES.filter((from) => canTransition(from, to));
}
