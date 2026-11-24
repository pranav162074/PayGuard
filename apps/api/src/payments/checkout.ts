import type { Config } from "../config.js";
import { ApiError } from "../errors.js";
import {
  GatewayError,
  RazorpayClient,
  verifyPaymentSignature,
  type Fetch,
  type RazorpayPayment,
} from "../gateway/razorpay.js";
import type { Logger } from "../logger.js";
import type { KeyMode } from "../models/index.js";
import type { PaymentIntent } from "./models.js";
import { failIntent, markProcessing, succeedIntent, type PaymentDeps } from "./service.js";

/**
 * Taking real payments through Razorpay.
 *
 * 1. The checkout opens: we create a Razorpay order for the intent (once) and hand the
 *    browser its id. Razorpay's own checkout collects the card / UPI / netbanking details;
 *    they never touch our servers.
 * 2. The customer pays: the browser sends back Razorpay's signed result. We check the
 *    signature, then ask Razorpay's API what actually happened.
 *
 * Everything that learns about a payment ends in syncIntent(), which treats Razorpay's API as
 * the source of truth and applies the result through the state machine. Running it twice, or
 * from two places at once, can't double-charge or double-post: the transitions and the
 * ledger are idempotent. (Razorpay's webhooks will call it too, in the next branch.)
 */

export type Gateways = Record<KeyMode, RazorpayClient | null>;

export function createGateways(config: Config, fetchImpl?: Fetch): Gateways {
  const { test, live, apiUrl } = config.razorpay;
  return {
    test: test ? new RazorpayClient(test, apiUrl, fetchImpl) : null,
    live: live ? new RazorpayClient(live, apiUrl, fetchImpl) : null,
  };
}

export type CheckoutDeps = PaymentDeps & { gateways: Gateways; logger: Logger };

export function gatewayFor(deps: CheckoutDeps, mode: KeyMode): RazorpayClient {
  const client = deps.gateways[mode];
  if (!client) {
    throw new ApiError(
      503,
      "gateway_not_configured",
      `${mode === "live" ? "Live" : "Test"} payments aren't set up on this server yet`,
    );
  }
  return client;
}

function gatewayFailure(err: unknown): never {
  if (err instanceof GatewayError) {
    throw new ApiError(502, "gateway_error", `The payment gateway failed: ${err.message}`);
  }
  throw err;
}

const OPEN_FOR_PAYMENT = new Set(["requires_payment", "failed"]);

async function reload(deps: PaymentDeps, intentId: string): Promise<PaymentIntent> {
  const intent = await deps.models.PaymentIntent.findById(intentId).lean<PaymentIntent>();
  if (!intent) throw new ApiError(404, "not_found", "Payment intent not found");
  return intent;
}

/**
 * Makes sure the intent has a Razorpay order, creating one the first time the checkout
 * opens. Two checkouts opening at once may both create an order at Razorpay; only one is
 * saved (a conditional update), and the other is simply never paid.
 */
export async function ensureOrder(
  deps: CheckoutDeps,
  intent: PaymentIntent,
): Promise<PaymentIntent> {
  if (intent.gateway?.orderId || !OPEN_FOR_PAYMENT.has(intent.status)) return intent;
  const client = gatewayFor(deps, intent.mode);
  const order = await client
    .createOrder({
      amount: intent.amount,
      currency: intent.currency,
      receipt: intent._id,
      notes: { payment_intent: intent._id, merchant_id: intent.merchantId.toString() },
    })
    .catch(gatewayFailure);
  const saved = await deps.models.PaymentIntent.findOneAndUpdate(
    { _id: intent._id, "gateway.orderId": null },
    { $set: { "gateway.provider": "razorpay", "gateway.orderId": order.id } },
    { returnDocument: "after" },
  ).lean<PaymentIntent>();
  return saved ?? reload(deps, intent._id);
}

/**
 * The checkout's success callback. A valid signature proves the customer paid against this
 * order; Razorpay's API then says whether the money is captured yet.
 */
export async function confirmPayment(
  deps: CheckoutDeps,
  intent: PaymentIntent,
  input: { orderId: string; paymentId: string; signature: string },
): Promise<PaymentIntent> {
  const orderId = intent.gateway?.orderId;
  if (!orderId || input.orderId !== orderId) {
    throw new ApiError(422, "order_mismatch", "This payment belongs to a different order");
  }
  const client = gatewayFor(deps, intent.mode);
  if (!verifyPaymentSignature(client.keys.keySecret, orderId, input.paymentId, input.signature)) {
    deps.logger.warn({ intentId: intent._id }, "Checkout confirmation with a bad signature");
    throw new ApiError(400, "invalid_signature", "The payment signature doesn't match");
  }
  if (OPEN_FOR_PAYMENT.has(intent.status)) {
    // Record that the customer paid before asking Razorpay anything, so even if Razorpay is
    // unreachable right now, the reconciler knows to come back to this payment
    try {
      await markProcessing(deps, intent._id);
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "invalid_state")) throw err;
    }
  }
  try {
    return await syncIntent(deps, intent._id);
  } catch (err) {
    if (err instanceof GatewayError && err.retryable) return reload(deps, intent._id);
    return gatewayFailure(err);
  }
}

function newestFirst(payments: RazorpayPayment[]): RazorpayPayment[] {
  // Razorpay lists newest first, but don't rely on it: payment ids sort by creation time
  return [...payments].sort((a, b) => (a.id < b.id ? 1 : -1));
}

/** Tolerates a concurrent path having moved the intent on already. */
async function applying(
  deps: PaymentDeps,
  intentId: string,
  change: () => Promise<PaymentIntent>,
): Promise<PaymentIntent> {
  try {
    return await change();
  } catch (err) {
    if (err instanceof ApiError && err.code === "invalid_state") return reload(deps, intentId);
    throw err;
  }
}

/**
 * Asks Razorpay about the intent's order and applies what it says:
 * - a captured payment for the right amount: the intent succeeds (ledger and all);
 * - an authorized payment: capture it first (accounts without auto-capture);
 * - only failed attempts: the intent fails, and the customer can try again;
 * - nothing yet: no change.
 * Throws GatewayError when Razorpay can't be asked.
 */
export async function syncIntent(deps: CheckoutDeps, intentId: string): Promise<PaymentIntent> {
  const intent = await reload(deps, intentId);
  const orderId = intent.gateway?.orderId;
  if (!orderId || intent.status === "succeeded") return intent;
  const client = gatewayFor(deps, intent.mode);

  const payments = newestFirst(await client.orderPayments(orderId));
  await deps.models.PaymentIntent.updateOne(
    { _id: intentId },
    { $set: { "gateway.checkedAt": new Date() } },
  );

  let captured = payments.find((p) => p.status === "captured" || p.status === "refunded");
  if (!captured) {
    const authorized = payments.find((p) => p.status === "authorized");
    if (authorized) {
      captured = await client.capture(authorized.id, authorized.amount, authorized.currency);
    }
  }

  if (captured) {
    const log = { intentId, orderId, paymentId: captured.id };
    if (captured.amount !== intent.amount || captured.currency !== intent.currency) {
      // Can't happen through an order (Razorpay enforces its amount), so it needs a human
      deps.logger.error(
        { ...log, expected: intent.amount, got: captured.amount },
        "Captured amount doesn't match the payment intent; not marking it paid",
      );
      return intent;
    }
    if (intent.status === "canceled") {
      deps.logger.error(log, "Payment captured for a canceled intent; it needs a refund");
      return intent;
    }
    return applying(deps, intentId, () =>
      succeedIntent(deps, intentId, {
        "gateway.paymentId": captured.id,
        "gateway.method": captured.method,
      }),
    );
  }

  const latest = payments[0];
  if (
    latest &&
    payments.every((p) => p.status === "failed") &&
    (intent.status === "requires_payment" || intent.status === "processing")
  ) {
    const reason = latest.error_description ?? latest.error_code ?? "payment_failed";
    return applying(deps, intentId, () => failIntent(deps, intentId, reason));
  }
  return reload(deps, intentId);
}
