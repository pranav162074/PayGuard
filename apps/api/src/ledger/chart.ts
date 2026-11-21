/**
 * The chart of accounts every merchant gets, separately for test and live mode.
 *
 * Asset and expense accounts grow with debits; liability, revenue and equity accounts grow
 * with credits (their "normal side"). Balances are stored in normal-side terms, so a positive
 * merchant_payable is money we owe the merchant.
 */
export const ACCOUNT_TYPES = ["asset", "liability", "revenue", "expense", "equity"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type AccountSpec = {
  code: string;
  name: string;
  type: AccountType;
  /** False: postings that would take the balance below zero are refused. */
  allowNegative: boolean;
};

export const CHART: readonly AccountSpec[] = [
  {
    code: "gateway_receivable",
    name: "Owed to us by the payment gateway (captured, not yet settled)",
    type: "asset",
    // Refunds net against it, so after a payout it can dip below zero: we owe the gateway
    allowNegative: true,
  },
  {
    code: "bank",
    name: "Settled funds in the bank",
    type: "asset",
    allowNegative: false,
  },
  {
    code: "merchant_payable",
    name: "Merchant balance: what we owe the merchant",
    type: "liability",
    // A refund can't take more than the merchant has
    allowNegative: false,
  },
  {
    code: "fee_revenue",
    name: "Processing fees earned",
    type: "revenue",
    allowNegative: true,
  },
];

export const ACCOUNT_CODES = CHART.map((a) => a.code);

export function normalSide(type: AccountType): "debit" | "credit" {
  return type === "asset" || type === "expense" ? "debit" : "credit";
}

export function specFor(code: string): AccountSpec | undefined {
  return CHART.find((a) => a.code === code);
}
