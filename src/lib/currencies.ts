// Common currencies for finance dropdowns (East Africa + majors first).
export const CURRENCIES: string[] = [
  "UGX", "USD", "EUR", "GBP", "KES", "TZS", "RWF", "SSP", "BIF", "ETB",
  "ZAR", "NGN", "GHS", "XAF", "XOF", "CAD", "AUD", "JPY", "CHF", "CNY", "INR", "SEK", "NOK", "DKK",
];

// Ensure a given currency is present (so existing values still appear in selects).
export function currencyOptions(current?: string | null): string[] {
  if (current && !CURRENCIES.includes(current)) return [current, ...CURRENCIES];
  return CURRENCIES;
}
