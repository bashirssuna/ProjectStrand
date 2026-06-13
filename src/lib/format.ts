export function money(n: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency, maximumFractionDigits: 0,
  }).format(n || 0);
}

export function num(n: number): string {
  return new Intl.NumberFormat("en-US").format(n || 0);
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
