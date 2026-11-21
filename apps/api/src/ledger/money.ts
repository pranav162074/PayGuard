/**
 * Money is always an integer number of minor units (paise for INR), never a float:
 * 0.1 + 0.2 !== 0.3 in floating point, and a ledger must add up to the last paisa.
 *
 * Integers up to 2^53 are exact in a JS number, and the cap below (₹100 crore per amount)
 * keeps every sum of a realistic number of amounts far inside that range.
 */
export const CURRENCIES = ["INR"] as const;
export type Currency = (typeof CURRENCIES)[number];

const MINOR_UNITS: Record<Currency, number> = { INR: 2 };

export const MAX_AMOUNT = 1_000_000_000_00; // ₹100 crore, in paise

export class MoneyError extends Error {
  override name = "MoneyError";
}

export function assertAmount(amount: number, what = "amount"): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new MoneyError(
      `${what} must be a whole number of minor units between 1 and ${MAX_AMOUNT}`,
    );
  }
}

/** "1234.5" → 123450. Parses the decimal string directly, so no float ever touches it. */
export function parseAmount(value: string, currency: Currency): number {
  const digits = MINOR_UNITS[currency];
  const match = /^(\d{1,15})(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new MoneyError(`"${value}" is not an amount`);
  const [, whole = "0", fraction = ""] = match;
  if (fraction.length > digits) {
    throw new MoneyError(`${currency} amounts have at most ${digits} decimal places`);
  }
  const amount = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0") || "0");
  assertAmount(amount);
  return amount;
}

/** 123450 → "1234.50" */
export function formatAmount(amount: number, currency: Currency): string {
  const digits = MINOR_UNITS[currency];
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount)
    .toString()
    .padStart(digits + 1, "0");
  return `${sign}${abs.slice(0, -digits)}.${abs.slice(-digits)}`;
}

/**
 * A fee in basis points (1 bp = 0.01%), rounded half up to the paisa.
 * 2% of ₹100.25 = 200 bp of 10025 paise = 200.5 → 201 paise.
 */
export function feeFor(amount: number, basisPoints: number): number {
  assertAmount(amount);
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new MoneyError("basisPoints must be an integer from 0 to 10000");
  }
  // Integer arithmetic: floor((amount * bp + 5000) / 10000) is "round half up"
  return Math.floor((amount * basisPoints + 5_000) / 10_000);
}

/**
 * Splits an amount by weights so the parts always add up to exactly the amount: each part
 * gets its rounded-down share, and the leftover paise go to the largest remainders.
 * allocate(100, [1, 1, 1]) → [34, 33, 33]
 */
export function allocate(amount: number, weights: number[]): number[] {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new MoneyError("Invalid amount");
  if (weights.length === 0 || weights.some((w) => !Number.isInteger(w) || w < 0)) {
    throw new MoneyError("Weights must be non-negative integers");
  }
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (total === 0) throw new MoneyError("Weights can't all be zero");

  const parts = weights.map((w) => Math.floor((amount * w) / total));
  let leftover = amount - parts.reduce((sum, p) => sum + p, 0);
  const byRemainder = weights
    .map((w, i) => ({ i, remainder: (amount * w) % total }))
    .sort((a, b) => b.remainder - a.remainder || a.i - b.i);
  for (const { i } of byRemainder) {
    if (leftover === 0) break;
    parts[i] = (parts[i] ?? 0) + 1;
    leftover -= 1;
  }
  return parts;
}
