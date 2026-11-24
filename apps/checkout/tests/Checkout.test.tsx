import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckoutError, type CheckoutApi, type CheckoutData } from "../src/api";
import { Checkout } from "../src/Checkout";
import { formatMoney } from "../src/format";
import { parseCheckoutLink } from "../src/link";
import type { RazorpayConstructor, RazorpayFailure, RazorpayOptions } from "../src/razorpay";

afterEach(cleanup);

const ID = "pi_0123456789abcdef01234567";
const SECRET = "cs_secret";

function payment(overrides: Partial<CheckoutData> = {}): CheckoutData {
  return {
    id: ID,
    status: "requires_payment",
    amount: 50_000,
    currency: "INR",
    description: "Masala chai x5",
    mode: "test",
    merchant: { name: "Chai Point" },
    customer: { email: "buyer@example.com", phone: null },
    failure_reason: null,
    razorpay: { key_id: "rzp_test_abc", order_id: "order_123" },
    ...overrides,
  };
}

/** A stand-in for Razorpay's checkout that records how it was opened. */
function fakeRazorpay() {
  const opened: RazorpayOptions[] = [];
  let onFailed: ((failure: RazorpayFailure) => void) | undefined;
  class FakeRazorpay {
    constructor(readonly options: RazorpayOptions) {}
    open() {
      opened.push(this.options);
    }
    on(_event: "payment.failed", callback: (failure: RazorpayFailure) => void) {
      onFailed = callback;
    }
  }
  return {
    load: () => Promise.resolve(FakeRazorpay as unknown as RazorpayConstructor),
    opened,
    fail: (description: string) => onFailed?.({ error: { description } }),
  };
}

function api(overrides: Partial<CheckoutApi> = {}): CheckoutApi {
  return {
    load: vi.fn(() => Promise.resolve(payment())),
    confirm: vi.fn(() => Promise.resolve(payment({ status: "succeeded", razorpay: null }))),
    ...overrides,
  };
}

describe("checkout page", () => {
  it("shows the merchant, amount and test-mode badge, and a pay button", async () => {
    render(<Checkout paymentId={ID} clientSecret={SECRET} api={api()} />);

    expect(await screen.findByText("Chai Point")).toBeTruthy();
    expect(screen.getByRole("heading").textContent).toBe(formatMoney(50_000, "INR"));
    expect(screen.getByText("Masala chai x5")).toBeTruthy();
    expect(screen.getByText(/TEST MODE/)).toBeTruthy();
    expect(screen.getByRole("button").textContent).toBe(`Pay ${formatMoney(50_000, "INR")}`);
  });

  it("opens Razorpay with the order, and confirms the signed result with the server", async () => {
    const razorpay = fakeRazorpay();
    const client = api();
    render(
      <Checkout paymentId={ID} clientSecret={SECRET} api={client} loadRazorpay={razorpay.load} />,
    );

    await userEvent.click(await screen.findByRole("button"));
    await waitFor(() => {
      expect(razorpay.opened).toHaveLength(1);
    });
    const options = razorpay.opened[0];
    expect(options).toMatchObject({
      key: "rzp_test_abc",
      order_id: "order_123",
      amount: 50_000,
      currency: "INR",
      name: "Chai Point",
      prefill: { email: "buyer@example.com" },
    });

    const result = {
      razorpay_payment_id: "pay_1",
      razorpay_order_id: "order_123",
      razorpay_signature: "f".repeat(64),
    };
    options?.handler(result);

    expect(await screen.findByText("Payment received. Thank you!")).toBeTruthy();
    expect(client.confirm).toHaveBeenCalledWith(ID, SECRET, result);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lets the customer retry after the bank declines", async () => {
    const razorpay = fakeRazorpay();
    render(
      <Checkout paymentId={ID} clientSecret={SECRET} api={api()} loadRazorpay={razorpay.load} />,
    );
    await userEvent.click(await screen.findByRole("button"));
    await waitFor(() => {
      expect(razorpay.opened).toHaveLength(1);
    });

    razorpay.fail("Payment declined by bank");

    expect(await screen.findByText("Payment declined by bank. You can try again.")).toBeTruthy();
  });

  it("re-checks a payment the bank is still confirming until it settles", async () => {
    const load = vi
      .fn<CheckoutApi["load"]>()
      .mockResolvedValueOnce(payment({ status: "processing", razorpay: null }))
      .mockResolvedValueOnce(payment({ status: "processing", razorpay: null }))
      .mockResolvedValue(payment({ status: "succeeded", razorpay: null }));
    render(<Checkout paymentId={ID} clientSecret={SECRET} api={api({ load })} pollMs={10} />);

    expect(await screen.findByText(/confirming with your bank/)).toBeTruthy();
    expect(await screen.findByText("Payment received. Thank you!")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("explains a failed confirmation without claiming the money is lost", async () => {
    const razorpay = fakeRazorpay();
    const confirm = vi.fn(() =>
      Promise.reject(new CheckoutError("The payment gateway failed", 502)),
    );
    render(
      <Checkout
        paymentId={ID}
        clientSecret={SECRET}
        api={api({ confirm })}
        loadRazorpay={razorpay.load}
      />,
    );
    await userEvent.click(await screen.findByRole("button"));
    await waitFor(() => {
      expect(razorpay.opened).toHaveLength(1);
    });
    razorpay.opened[0]?.handler({
      razorpay_payment_id: "pay_1",
      razorpay_order_id: "order_123",
      razorpay_signature: "f".repeat(64),
    });

    expect(
      await screen.findByText(
        "The payment gateway failed. If you were charged, it will be confirmed shortly.",
      ),
    ).toBeTruthy();
  });

  it("shows no pay button for canceled or paid payments", async () => {
    render(
      <Checkout
        paymentId={ID}
        clientSecret={SECRET}
        api={api({
          load: () =>
            Promise.resolve(payment({ status: "canceled", razorpay: null, mode: "live" })),
        })}
      />,
    );
    expect(await screen.findByText(/canceled by the merchant/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText(/TEST MODE/)).toBeNull();
  });

  it("shows the server's message when the link is wrong or expired", async () => {
    render(
      <Checkout
        paymentId={ID}
        clientSecret="cs_wrong"
        api={api({
          load: () => Promise.reject(new CheckoutError("Payment not found", 404)),
        })}
      />,
    );
    expect((await screen.findByRole("alert")).textContent).toBe("Payment not found");
  });
});

describe("checkout links", () => {
  it("reads the payment id and secret, and rejects anything else", () => {
    expect(
      parseCheckoutLink({ pathname: `/pay/${ID}`, search: `?client_secret=${SECRET}` }),
    ).toEqual({ paymentId: ID, clientSecret: SECRET });
    expect(parseCheckoutLink({ pathname: `/pay/${ID}`, search: "" })).toBeNull();
    expect(parseCheckoutLink({ pathname: "/pay/../admin", search: "?client_secret=x" })).toBeNull();
    expect(parseCheckoutLink({ pathname: "/", search: "?client_secret=x" })).toBeNull();
  });
});
