import { createHmac, timingSafeEqual } from "node:crypto";

import type { GatewayKeys } from "../config.js";

/**
 * A small Razorpay client: only the calls PayGuard needs, over plain fetch (no SDK), with a
 * timeout on every request. `fetch` is injectable so tests can stand in for Razorpay.
 *
 * Docs: https://razorpay.com/docs/api/orders/ and https://razorpay.com/docs/api/payments/
 */

export type RazorpayOrder = {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: "created" | "attempted" | "paid";
};

export type RazorpayPayment = {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  /** created → authorized → captured (→ refunded), or failed */
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method: string | null;
  error_code: string | null;
  error_description: string | null;
  /** Unix seconds */
  created_at?: number;
  amount_refunded?: number;
};

/**
 * One line of Razorpay's settlement reconciliation report (GET /settlements/recon/combined):
 * a payment, refund or adjustment, and the settlement (bank transfer) it was paid out in.
 */
export type RazorpayReconItem = {
  entity_id: string;
  type: "payment" | "refund" | "adjustment" | "transfer";
  /** The payment or refund amount, in paise */
  amount: number;
  /** Razorpay's fee and the GST on it, in paise (payments only) */
  fee: number;
  tax: number;
  /** What the line added to (credit) or took from (debit) the settlement */
  credit: number;
  debit: number;
  currency: string;
  settled: boolean;
  settlement_id: string | null;
  settlement_utr: string | null;
  /** Unix seconds */
  settled_at: number | null;
  order_id: string | null;
  payment_id: string | null;
};

const PAGE = 100;

export type RazorpayRefund = {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  /** Refunds in test mode are processed at once; live ones can stay pending for days. */
  status: "pending" | "processed" | "failed";
  notes: Record<string, string> | [] | null;
};

export class GatewayError extends Error {
  override name = "GatewayError";

  constructor(
    message: string,
    /** Razorpay's HTTP status, or 0 when it couldn't be reached. */
    readonly status: number,
    readonly code: string | null = null,
  ) {
    super(message);
  }

  /** Worth retrying later: Razorpay unreachable, rate limited or failing on its side. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export type Fetch = typeof fetch;

const TIMEOUT_MS = 10_000;

export class RazorpayClient {
  constructor(
    readonly keys: GatewayKeys,
    private readonly apiUrl: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const auth = Buffer.from(`${this.keys.keyId}:${this.keys.keySecret}`).toString("base64");
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GatewayError(`Razorpay unreachable: ${(err as Error).message}`, 0);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // Not JSON (a proxy's error page, say): fall through with the raw status
    }
    if (!res.ok) {
      const error = (json as { error?: { code?: string; description?: string } } | null)?.error;
      throw new GatewayError(
        error?.description ?? `Razorpay returned ${res.status}`,
        res.status,
        error?.code ?? null,
      );
    }
    return json as T;
  }

  createOrder(input: {
    amount: number;
    currency: string;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<RazorpayOrder> {
    return this.call<RazorpayOrder>("POST", "/orders", input);
  }

  async orderPayments(orderId: string): Promise<RazorpayPayment[]> {
    const page = await this.call<{ items: RazorpayPayment[] }>(
      "GET",
      `/orders/${encodeURIComponent(orderId)}/payments`,
    );
    return page.items;
  }

  /** Refunds part or all of a captured payment. */
  createRefund(
    paymentId: string,
    input: { amount: number; notes: Record<string, string>; receipt: string },
  ): Promise<RazorpayRefund> {
    return this.call<RazorpayRefund>("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, {
      ...input,
      speed: "normal",
    });
  }

  /** Every refund of a payment: used to find one we created but didn't get to record. */
  async paymentRefunds(paymentId: string): Promise<RazorpayRefund[]> {
    const page = await this.call<{ items: RazorpayRefund[] }>(
      "GET",
      `/payments/${encodeURIComponent(paymentId)}/refunds?count=100`,
    );
    return page.items;
  }

  getRefund(refundId: string): Promise<RazorpayRefund> {
    return this.call<RazorpayRefund>("GET", `/refunds/${encodeURIComponent(refundId)}`);
  }

  /** Every payment created in [from, to), unix seconds, following Razorpay's pagination. */
  async listPayments(from: number, to: number): Promise<RazorpayPayment[]> {
    const all: RazorpayPayment[] = [];
    for (let skip = 0; ; skip += PAGE) {
      const page = await this.call<{ items: RazorpayPayment[] }>(
        "GET",
        `/payments?from=${from}&to=${to}&count=${PAGE}&skip=${skip}`,
      );
      all.push(...page.items);
      if (page.items.length < PAGE) return all;
    }
  }

  /** The settlement report for one day: every line settled that day. */
  async settlementRecon(year: number, month: number, day: number): Promise<RazorpayReconItem[]> {
    const all: RazorpayReconItem[] = [];
    for (let skip = 0; ; skip += PAGE) {
      const page = await this.call<{ items: RazorpayReconItem[] }>(
        "GET",
        `/settlements/recon/combined?year=${year}&month=${month}&day=${day}&count=${PAGE}&skip=${skip}`,
      );
      all.push(...page.items);
      if (page.items.length < PAGE) return all;
    }
  }

  /** Captures an authorized payment (only needed when the account doesn't auto-capture). */
  capture(paymentId: string, amount: number, currency: string): Promise<RazorpayPayment> {
    return this.call<RazorpayPayment>(
      "POST",
      `/payments/${encodeURIComponent(paymentId)}/capture`,
      {
        amount,
        currency,
      },
    );
  }
}

// ------------------------------------------------------------------------- signatures --

function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Constant-time comparison, so response timing doesn't leak how much of a guess was right. */
function sameHex(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The checkout hands the browser `razorpay_signature` = HMAC-SHA256(order_id + "|" +
 * payment_id) with our key secret. Only Razorpay and we know the secret, so a valid
 * signature proves this payment was made against this order.
 */
export function verifyPaymentSignature(
  keySecret: string,
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  return sameHex(hmacHex(keySecret, `${orderId}|${paymentId}`), signature);
}

/** Webhooks carry X-Razorpay-Signature = HMAC-SHA256 of the exact raw body. */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signature: string,
): boolean {
  return sameHex(hmacHex(secret, rawBody), signature);
}

/** For tests and local tools: what Razorpay would send. */
export function signPayment(keySecret: string, orderId: string, paymentId: string): string {
  return hmacHex(keySecret, `${orderId}|${paymentId}`);
}

export function signWebhook(secret: string, rawBody: string | Buffer): string {
  return hmacHex(secret, rawBody);
}
