import { useCallback, useEffect, useState } from "react";

import { checkoutApi, CheckoutError, type CheckoutApi, type CheckoutData } from "./api";
import { formatMoney } from "./format";
import { loadRazorpay as defaultLoadRazorpay, type RazorpayConstructor } from "./razorpay";

type Props = {
  paymentId: string;
  clientSecret: string;
  /** Injectable for tests. */
  api?: CheckoutApi;
  loadRazorpay?: () => Promise<RazorpayConstructor>;
  /** How often to re-check a payment the bank is still confirming. */
  pollMs?: number;
};

type Notice = { kind: "info" | "ok" | "error"; text: string } | null;

function noticeFor(data: CheckoutData): Notice {
  switch (data.status) {
    case "succeeded":
      return { kind: "ok", text: "Payment received. Thank you!" };
    case "processing":
      return { kind: "info", text: "Payment received, confirming with your bank…" };
    case "canceled":
      return { kind: "error", text: "This payment was canceled by the merchant." };
    case "failed":
      return {
        kind: "error",
        text: `The last attempt failed${data.failure_reason ? ` (${data.failure_reason})` : ""}. You can try again.`,
      };
    case "requires_payment":
      return null;
  }
}

const canPay = (data: CheckoutData) =>
  data.razorpay !== null && (data.status === "requires_payment" || data.status === "failed");

export function Checkout({
  paymentId,
  clientSecret,
  api = checkoutApi,
  loadRazorpay = defaultLoadRazorpay,
  pollMs = 3000,
}: Props) {
  const [data, setData] = useState<CheckoutData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const show = useCallback((next: CheckoutData) => {
    setData(next);
    setNotice(noticeFor(next));
  }, []);

  useEffect(() => {
    let active = true;
    api.load(paymentId, clientSecret).then(
      (loaded) => {
        if (active) show(loaded);
      },
      (err: unknown) => {
        if (active) setLoadError(err instanceof Error ? err.message : "Something went wrong");
      },
    );
    return () => {
      active = false;
    };
  }, [api, paymentId, clientSecret, show]);

  // While the bank confirms, check again every few seconds; the server settles it from
  // Razorpay's side even if this tab closes
  useEffect(() => {
    if (data?.status !== "processing") return;
    const timer = setTimeout(() => {
      api.load(paymentId, clientSecret).then(show, () => undefined);
    }, pollMs);
    return () => {
      clearTimeout(timer);
    };
  }, [api, data, paymentId, clientSecret, pollMs, show]);

  async function pay() {
    if (!data?.razorpay) return;
    setBusy(true);
    let Razorpay: RazorpayConstructor;
    try {
      Razorpay = await loadRazorpay();
    } catch {
      setNotice({
        kind: "error",
        text: "The payment window couldn't load. Check your connection.",
      });
      setBusy(false);
      return;
    }
    const checkout = new Razorpay({
      key: data.razorpay.key_id,
      order_id: data.razorpay.order_id,
      amount: data.amount,
      currency: data.currency,
      name: data.merchant.name,
      description: data.description ?? undefined,
      prefill: {
        email: data.customer.email ?? undefined,
        contact: data.customer.phone ?? undefined,
      },
      handler: (result) => {
        setNotice({ kind: "info", text: "Confirming your payment…" });
        api.confirm(paymentId, clientSecret, result).then(show, (err: unknown) => {
          // The money may well have gone through; the server will confirm it either way
          const message = err instanceof CheckoutError ? err.message : "Something went wrong";
          setNotice({
            kind: "error",
            text: `${message}. If you were charged, it will be confirmed shortly.`,
          });
          setBusy(false);
        });
      },
      modal: {
        ondismiss: () => {
          setBusy(false);
        },
      },
    });
    checkout.on("payment.failed", (failure) => {
      const reason = failure.error?.description ?? "The payment failed";
      setNotice({ kind: "error", text: `${reason}. You can try again.` });
    });
    checkout.open();
  }

  if (loadError) {
    return (
      <main className="card">
        <p className="notice error" role="alert">
          {loadError}
        </p>
      </main>
    );
  }
  if (!data) {
    return (
      <main className="card" aria-busy="true">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const amount = formatMoney(data.amount, data.currency);
  return (
    <main className="card">
      {data.mode === "test" && <span className="badge">TEST MODE · no real money moves</span>}
      <p className="merchant">{data.merchant.name || "Payment"}</p>
      <h1 className="amount">{amount}</h1>
      {data.description && <p className="muted">{data.description}</p>}

      {canPay(data) && (
        <button type="button" onClick={() => void pay()} disabled={busy}>
          {data.status === "failed" ? `Try again · ${amount}` : `Pay ${amount}`}
        </button>
      )}

      <p className={`notice ${notice?.kind ?? ""}`} role="status" aria-live="polite">
        {notice?.text}
      </p>
      <p className="foot">Secured by PayGuard · Payments processed by Razorpay</p>
    </main>
  );
}
