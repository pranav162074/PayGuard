/** 50000 paise → "₹500.00" */
export function formatMoney(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(minorUnits / 100);
}
