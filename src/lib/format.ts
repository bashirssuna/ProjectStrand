export function money(n: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, maximumFractionDigits: 0,
  }).format(n || 0);
}

export function num(n: number): string {
  return new Intl.NumberFormat("en-US").format(n || 0);
}

// Summarises a set of per-currency amounts for a headline stat. Records mixing
// several currencies cannot be added into one number, so a single currency is
// shown formatted, while a mix shows "N currencies" with a breakdown to list.
// `fallback` is only used when there are no amounts at all.
export type CcyTotal = { value: string; parts: [string, number][]; mixed: boolean; empty: boolean };
export function ccyTotal(byCcy: Record<string, number>, fallback = "USD"): CcyTotal {
  const keys = Object.keys(byCcy).sort();
  const parts = keys.map((k) => [k, byCcy[k]] as [string, number]);
  if (keys.length === 0) return { value: money(0, fallback), parts: [], mixed: false, empty: true };
  if (keys.length === 1) return { value: money(byCcy[keys[0]], keys[0]), parts, mixed: false, empty: false };
  return { value: `${keys.length} currencies`, parts, mixed: true, empty: false };
}

// Convenience: builds a per-currency map from rows carrying an amount + currency.
export function groupByCcy<T>(rows: T[], amount: (r: T) => number, currency: (r: T) => string | null | undefined, fallback = "USD"): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) { const c = currency(r) || fallback; m[c] = (m[c] ?? 0) + (amount(r) || 0); }
  return m;
}

export function pct(n: number): string {
  return `${Math.round(n)}%`;
}

export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function fmtDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// Formats a DB timestamp (string in PGlite, Date in node-postgres) as YYYY-MM-DD
// for an <input type="date"> value, safely across both drivers.
export function dateInput(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  if (isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}
