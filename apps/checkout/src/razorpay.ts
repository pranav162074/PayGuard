import type { RazorpayResult } from "./api";

/**
 * Razorpay's checkout (https://razorpay.com/docs/payments/payment-gateway/web-integration/).
 * It opens Razorpay's own window, which collects the card / UPI / netbanking details: they
 * never pass through our code or servers.
 */
export type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  prefill?: { email?: string; contact?: string };
  handler: (result: RazorpayResult) => void;
  modal?: { ondismiss?: () => void };
};

export type RazorpayFailure = { error?: { description?: string; reason?: string } };

export type RazorpayCheckout = {
  open: () => void;
  on: (event: "payment.failed", callback: (failure: RazorpayFailure) => void) => void;
};

export type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayCheckout;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

const SCRIPT_URL = "https://checkout.razorpay.com/v1/checkout.js";
let loading: Promise<RazorpayConstructor> | null = null;

/** Loads Razorpay's script once, the first time someone presses Pay. */
export function loadRazorpay(): Promise<RazorpayConstructor> {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  loading ??= new Promise<RazorpayConstructor>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error("Razorpay didn't load"));
    };
    script.onerror = () => {
      loading = null; // let the next click try again
      reject(new Error("Couldn't load the payment window"));
    };
    document.head.appendChild(script);
  });
  return loading;
}
