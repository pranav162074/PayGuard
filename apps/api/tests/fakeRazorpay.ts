import { randomBytes } from "node:crypto";

import type { RazorpayOrder, RazorpayPayment, RazorpayRefund } from "../src/gateway/razorpay.js";

/**
 * An in-memory stand-in for Razorpay's Orders and Payments API, served through a `fetch`
 * function, so tests exercise the real HTTP client code. Tests play the customer with pay().
 */
export class FakeRazorpay {
  orders = new Map<string, RazorpayOrder & { notes: Record<string, string> }>();
  payments = new Map<string, RazorpayPayment>();
  /** Every request made, as "METHOD /path". */
  calls: string[] = [];
  /** While set, every request fails with this HTTP status (0 = network error). */
  outage: number | null = null;
  /** Whether the account captures payments by itself (Razorpay's default). */
  autoCapture = true;
  refunds = new Map<string, RazorpayRefund>();
  /** What a new refund looks like: done at once (test mode), pending (live), or refused. */
  refundOutcome: "processed" | "pending" | "rejected" = "processed";
  /** Creates the next refund, then answers 503: Razorpay did it, but we never heard. */
  loseNextRefundResponse = false;
  private seq = 0;

  constructor(
    readonly keyId: string,
    readonly keySecret: string,
  ) {}

  private id(prefix: string): string {
    this.seq += 1;
    // Razorpay ids sort by creation time; keep that property
    return `${prefix}_${String(this.seq).padStart(6, "0")}${randomBytes(4).toString("hex")}`;
  }

  /** The customer completes (or fails) a payment on the checkout. */
  pay(
    orderId: string,
    outcome: "success" | "failure" = "success",
    overrides: Partial<RazorpayPayment> = {},
  ): RazorpayPayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`No order ${orderId}`);
    const payment: RazorpayPayment = {
      id: this.id("pay"),
      order_id: orderId,
      amount: order.amount,
      currency: order.currency,
      method: "upi",
      status: outcome === "failure" ? "failed" : this.autoCapture ? "captured" : "authorized",
      error_code: outcome === "failure" ? "BAD_REQUEST_ERROR" : null,
      error_description: outcome === "failure" ? "Payment declined by bank" : null,
      ...overrides,
    };
    this.payments.set(payment.id, payment);
    if (payment.status === "captured") order.status = "paid";
    else order.status = order.status === "paid" ? "paid" : "attempted";
    return payment;
  }

  /** The bank finishes (or gives up on) a pending refund. */
  settleRefund(refundId: string, status: "processed" | "failed"): RazorpayRefund {
    const refund = this.refunds.get(refundId);
    if (!refund) throw new Error(`No refund ${refundId}`);
    refund.status = status;
    return refund;
  }

  refundsOf(paymentId: string): RazorpayRefund[] {
    return [...this.refunds.values()].filter((r) => r.payment_id === paymentId);
  }

  fetch: typeof fetch = (input, init) => Promise.resolve().then(() => this.handle(input, init));

  private handle(input: string | URL | Request, init?: RequestInit): Response {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v1/, "");
    this.calls.push(`${method} ${path}`);
    if (this.outage === 0) throw new TypeError("fetch failed");
    if (this.outage)
      return json(this.outage, { error: { code: "SERVER_ERROR", description: "Down" } });

    const expected = `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString("base64")}`;
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== expected) {
      return json(401, {
        error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" },
      });
    }
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};

    if (method === "POST" && path === "/orders") {
      const order = {
        id: this.id("order"),
        amount: body.amount as number,
        currency: body.currency as string,
        receipt: typeof body.receipt === "string" ? body.receipt : null,
        status: "created" as const,
        notes: (body.notes ?? {}) as Record<string, string>,
      };
      this.orders.set(order.id, order);
      return json(200, { entity: "order", ...order });
    }
    let m = /^\/orders\/([^/]+)\/payments$/.exec(path);
    if (method === "GET" && m) {
      const orderId = decodeURIComponent(m[1] as string);
      if (!this.orders.has(orderId)) {
        return json(400, { error: { code: "BAD_REQUEST_ERROR", description: "Invalid order id" } });
      }
      const items = [...this.payments.values()]
        .filter((p) => p.order_id === orderId)
        .sort((a, b) => (a.id < b.id ? 1 : -1));
      return json(200, { entity: "collection", count: items.length, items });
    }
    m = /^\/payments\/([^/]+)\/capture$/.exec(path);
    if (method === "POST" && m) {
      const payment = this.payments.get(decodeURIComponent(m[1] as string));
      if (!payment || payment.status !== "authorized" || body.amount !== payment.amount) {
        return json(400, { error: { code: "BAD_REQUEST_ERROR", description: "Can't capture" } });
      }
      payment.status = "captured";
      return json(200, payment);
    }
    m = /^\/payments\/([^/]+)\/refund$/.exec(path);
    if (method === "POST" && m) {
      const payment = this.payments.get(decodeURIComponent(m[1] as string));
      const amount = body.amount as number;
      const refunded = payment
        ? this.refundsOf(payment.id)
            .filter((r) => r.status !== "failed")
            .reduce((sum, r) => sum + r.amount, 0)
        : 0;
      if (
        !payment ||
        payment.status !== "captured" ||
        this.refundOutcome === "rejected" ||
        refunded + amount > payment.amount
      ) {
        return json(400, {
          error: { code: "BAD_REQUEST_ERROR", description: "The refund can't be processed" },
        });
      }
      const refund: RazorpayRefund = {
        id: this.id("rfnd"),
        payment_id: payment.id,
        amount,
        currency: payment.currency,
        status: this.refundOutcome,
        notes: (body.notes ?? []) as Record<string, string>,
      };
      this.refunds.set(refund.id, refund);
      if (this.loseNextRefundResponse) {
        this.loseNextRefundResponse = false;
        return json(503, { error: { code: "SERVER_ERROR", description: "Gateway timeout" } });
      }
      return json(200, { entity: "refund", ...refund });
    }
    m = /^\/payments\/([^/]+)\/refunds$/.exec(path);
    if (method === "GET" && m) {
      const items = this.refundsOf(decodeURIComponent(m[1] as string));
      return json(200, { entity: "collection", count: items.length, items });
    }
    m = /^\/refunds\/([^/]+)$/.exec(path);
    if (method === "GET" && m) {
      const refund = this.refunds.get(decodeURIComponent(m[1] as string));
      if (!refund) {
        return json(400, {
          error: { code: "BAD_REQUEST_ERROR", description: "Invalid refund id" },
        });
      }
      return json(200, { entity: "refund", ...refund });
    }
    return json(404, { error: { code: "NOT_FOUND", description: "No such endpoint" } });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
