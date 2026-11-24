/** The checkout's view of a payment, from GET /v1/checkout/{id}. */
export type CheckoutStatus =
  "requires_payment" | "processing" | "succeeded" | "failed" | "canceled";

export type CheckoutData = {
  id: string;
  status: CheckoutStatus;
  amount: number; // paise
  currency: string;
  description: string | null;
  mode: "test" | "live";
  merchant: { name: string };
  customer: { email: string | null; phone: string | null };
  failure_reason: string | null;
  /** Present while the payment can be paid: what Razorpay's checkout needs. */
  razorpay: { key_id: string; order_id: string } | null;
};

/** What Razorpay's checkout hands back after a successful payment. */
export type RazorpayResult = {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
};

export class CheckoutError extends Error {
  override name = "CheckoutError";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(path: string, init?: RequestInit): Promise<CheckoutData> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new CheckoutError("Couldn't reach the payment server. Check your connection.", 0);
  }
  const body = (await res.json().catch(() => null)) as
    CheckoutData | { error?: { message?: string } } | null;
  if (!res.ok) {
    const message =
      body && "error" in body && body.error?.message ? body.error.message : "Something went wrong";
    throw new CheckoutError(message, res.status);
  }
  return body as CheckoutData;
}

export type CheckoutApi = {
  load: (id: string, clientSecret: string) => Promise<CheckoutData>;
  confirm: (id: string, clientSecret: string, result: RazorpayResult) => Promise<CheckoutData>;
};

export const checkoutApi: CheckoutApi = {
  load: (id, clientSecret) =>
    call(
      `/v1/checkout/${encodeURIComponent(id)}?client_secret=${encodeURIComponent(clientSecret)}`,
    ),
  confirm: (id, clientSecret, result) =>
    call(`/v1/checkout/${encodeURIComponent(id)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_secret: clientSecret, ...result }),
    }),
};
