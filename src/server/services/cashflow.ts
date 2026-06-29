import "server-only";
import { q, one } from "@/server/db";

export const FORECAST_CATEGORIES = ["Payroll", "Rent & utilities", "Grant income", "Operating costs", "Travel", "Equipment", "Tax / statutory", "Loan / financing", "Other"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function ymOf(d: string | Date): string {
  const dt = new Date(d);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}
function labelOf(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

export type ForecastRow = { id: string; name: string; currency: string; openingBalance: number; startDate: string; months: number; status: string; lines: number };
export async function listForecasts(orgId: string): Promise<ForecastRow[]> {
  return q<ForecastRow>(
    `SELECT f.id, f.name, f.currency, f.opening_balance::float8 AS "openingBalance", f.start_date AS "startDate", f.months, f.status,
            (SELECT COUNT(*) FROM cash_forecast_line l WHERE l.forecast_id=f.id)::int AS lines
     FROM cash_forecast f WHERE f.org_id=$1 ORDER BY f.status, f.created_at DESC`, [orgId]);
}

export type ForecastDetail = {
  id: string; name: string; currency: string; openingBalance: number; startDate: string; months: number;
  includeFunding: boolean; includeInvestments: boolean; status: string; notes: string | null;
};
export async function getForecast(orgId: string, id: string): Promise<ForecastDetail | null> {
  return one<ForecastDetail>(
    `SELECT id, name, currency, opening_balance::float8 AS "openingBalance", start_date AS "startDate", months,
            include_funding AS "includeFunding", include_investments AS "includeInvestments", status, notes
     FROM cash_forecast WHERE id=$1 AND org_id=$2`, [id, orgId]);
}

export type ForecastLine = { id: string; lineDate: string; direction: string; category: string | null; description: string | null; amount: number; recurring: string; recurUntil: string | null };
export async function listLines(orgId: string, forecastId: string): Promise<ForecastLine[]> {
  return q<ForecastLine>(
    `SELECT id, line_date AS "lineDate", direction, category, description, amount::float8 AS amount, recurring, recur_until AS "recurUntil"
     FROM cash_forecast_line WHERE forecast_id=$1 AND org_id=$2 ORDER BY line_date, created_at`, [forecastId, orgId]);
}

export type PeriodItem = { direction: "inflow" | "outflow"; source: "manual" | "funding" | "investment"; label: string; amount: number };
export type Period = { key: string; label: string; opening: number; inflow: number; outflow: number; net: number; closing: number; shortfall: boolean; items: PeriodItem[] };
export type Projection = {
  currency: string; openingBalance: number; periods: Period[];
  totalInflow: number; totalOutflow: number; endBalance: number; lowestClosing: number; anyShortfall: boolean;
};

export async function buildProjection(orgId: string, f: ForecastDetail): Promise<Projection> {
  // monthly buckets
  const start = new Date(f.startDate);
  let y = start.getUTCFullYear(), m = start.getUTCMonth();
  const keys: string[] = [];
  const map = new Map<string, Period>();
  for (let i = 0; i < Math.max(1, Math.min(f.months, 36)); i++) {
    const key = `${y}-${String(m + 1).padStart(2, "0")}`;
    keys.push(key);
    map.set(key, { key, label: labelOf(key), opening: 0, inflow: 0, outflow: 0, net: 0, closing: 0, shortfall: false, items: [] });
    m++; if (m > 11) { m = 0; y++; }
  }
  const lastKey = keys[keys.length - 1];
  const add = (key: string, item: PeriodItem) => {
    const p = map.get(key); if (!p) return;
    if (item.direction === "inflow") p.inflow += item.amount; else p.outflow += item.amount;
    p.items.push(item);
  };

  // manual lines (expand monthly recurring)
  const lines = await listLines(orgId, f.id);
  for (const ln of lines) {
    const startK = ymOf(ln.lineDate);
    const label = ln.description || ln.category || (ln.direction === "inflow" ? "Inflow" : "Outflow");
    if (ln.recurring === "monthly") {
      const untilK = ln.recurUntil ? ymOf(ln.recurUntil) : lastKey;
      for (const k of keys) if (k >= startK && k <= untilK) add(k, { direction: ln.direction as "inflow" | "outflow", source: "manual", label, amount: ln.amount });
    } else if (keys.includes(startK)) {
      add(startK, { direction: ln.direction as "inflow" | "outflow", source: "manual", label, amount: ln.amount });
    }
  }

  // auto: funding tranches (outstanding) expected within horizon
  if (f.includeFunding) {
    const tr = await q<{ donor: string; trLabel: string; expectedDate: string | null; outstanding: number }>(
      `SELECT a.donor, t.label AS "trLabel", t.expected_date AS "expectedDate",
              (t.amount - COALESCE((SELECT SUM(r.amount) FROM funding_receipt r WHERE r.tranche_id=t.id),0))::float8 AS outstanding
       FROM funding_tranche t JOIN funding_agreement a ON a.id=t.agreement_id
       WHERE a.org_id=$1 AND a.status='active' AND a.currency=$2 AND t.expected_date IS NOT NULL`, [orgId, f.currency]);
    for (const t of tr) {
      if (t.outstanding <= 0 || !t.expectedDate) continue;
      const k = ymOf(t.expectedDate);
      if (map.has(k)) add(k, { direction: "inflow", source: "funding", label: `${t.donor} — ${t.trLabel}`, amount: t.outstanding });
    }
  }

  // auto: investment maturities within horizon
  if (f.includeInvestments) {
    const inv = await q<{ name: string; maturityDate: string | null; value: number }>(
      `SELECT i.name, i.maturity_date AS "maturityDate",
              COALESCE(i.expected_value, i.principal + COALESCE((SELECT SUM(CASE WHEN type IN ('withdrawal','maturity') THEN -amount WHEN type='interest' THEN 0 ELSE amount END) FROM investment_movement WHERE investment_id=i.id),0))::float8 AS value
       FROM investment i WHERE i.org_id=$1 AND i.status='active' AND i.currency=$2 AND i.maturity_date IS NOT NULL`, [orgId, f.currency]);
    for (const iv of inv) {
      if (!iv.maturityDate || iv.value <= 0) continue;
      const k = ymOf(iv.maturityDate);
      if (map.has(k)) add(k, { direction: "inflow", source: "investment", label: `Maturity — ${iv.name}`, amount: iv.value });
    }
  }

  // running balances
  let running = f.openingBalance;
  let totalInflow = 0, totalOutflow = 0, lowest = Infinity, anyShortfall = false;
  for (const k of keys) {
    const p = map.get(k)!;
    p.opening = Math.round(running * 100) / 100;
    p.net = Math.round((p.inflow - p.outflow) * 100) / 100;
    running = Math.round((running + p.inflow - p.outflow) * 100) / 100;
    p.closing = running;
    p.shortfall = running < 0;
    if (p.shortfall) anyShortfall = true;
    if (running < lowest) lowest = running;
    totalInflow += p.inflow; totalOutflow += p.outflow;
  }
  return {
    currency: f.currency, openingBalance: f.openingBalance, periods: keys.map((k) => map.get(k)!),
    totalInflow: Math.round(totalInflow * 100) / 100, totalOutflow: Math.round(totalOutflow * 100) / 100,
    endBalance: running, lowestClosing: lowest === Infinity ? f.openingBalance : lowest, anyShortfall,
  };
}
