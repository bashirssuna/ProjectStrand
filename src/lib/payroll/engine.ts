// lib/payroll/engine.ts
// Project Strand — compensation engine.
// Pure, dependency-free, currency-agnostic. Every rate is configurable per
// organization/project; nothing is hard-coded. Verified to reproduce the
// uploaded Year 1 personnel sheet (Total Senior/Key Personnel = $235,600).

export type EmploymentType = "staff" | "consultant";
export type PayeMethod = "uganda" | "flat" | "none";

export interface FringeBenefit {
  label: string;       // e.g. "Fuel", "Gym membership", "Airtime"
  amount: number;      // absolute amount, drawn from the fringe pool, not part of gross
  taxable?: boolean;   // reserved: most NGO/grant benefits modelled as non-gross
}

export interface CompensationConfig {
  currency: string;                 // "USD", "UGX", ...
  nssfEmployerRate: number;         // default 0.15 (statutory UG = 0.10)
  nssfEmployeeRate: number;         // default 0.05
  consultantWHTRate: number;        // default 0.06 (withholding on requested funds)
  payeMethod: PayeMethod;           // "uganda" bands | "flat" | "none"
  payeFlatRate?: number;            // used when payeMethod === "flat"
  payeBands?: PayeBand[];           // optional override of the default Uganda bands
  nssfEmployerFromFringe: boolean;  // employer NSSF funded from the fringe pool (default true)
  nssfEmployeeFromFringe: boolean;  // employee NSSF funded from fringe instead of gross (default false)
  lstEnabled?: boolean;             // compute Local Service Tax (default off)
  lstBands?: LstBand[];             // optional override of the LST schedule
  lstAnnualDivisor?: number;        // spread the annual LST over N months (default 12)
}

export interface PayeBand {
  upTo: number | null;  // upper bound of the band; null = no upper bound
  rate: number;         // marginal rate on income within the band
  surchargeOver?: number;   // optional extra rate above a threshold
  surchargeThreshold?: number;
}

export interface StaffInput {
  type: "staff";
  name: string;
  role?: string;
  // Either provide grossSalary directly (the contracted gross actually paid)…
  grossSalary?: number;
  // …or provide base + effort to derive the charged salary (grant-budget style).
  baseSalary?: number;
  effortPct?: number;       // 0..1
  calMonths?: number;       // informational
  // Fringe: either an explicit pool, or a rate applied to a basis.
  fringeBudget?: number;
  fringeRatePct?: number;   // e.g. 0.30
  fringeBasis?: "base" | "charged";   // default "base" (matches the uploaded sheet)
  otherFringeBenefits?: FringeBenefit[];
  // Optional per-employee PAYE rate (0..1). When set, overrides the org PAYE
  // method with a flat rate for this person (useful for non-UGX salaries where
  // the banded scale doesn't apply).
  payeOverrideRate?: number;
  // Additional deductions/savings beyond NSSF & PAYE (e.g. SACCO, local service
  // tax, insurance). All reduce net take-home; "saving" ones are the employee's
  // own money set aside (shown separately), the rest are costs/levies.
  otherDeductions?: Deduction[];
}

export interface Deduction {
  label: string;
  amount: number;      // absolute amount (the service resolves % → amount)
  saving?: boolean;    // true = a saving scheme (e.g. SACCO); false = a tax/levy
}

export interface ConsultantInput {
  type: "consultant";
  name: string;
  role?: string;
  requestedFunds: number;
  effortPct?: number;
  calMonths?: number;
  otherDeductions?: Deduction[];
}

export type EmployeeInput = StaffInput | ConsultantInput;

export interface CompResult {
  type: EmploymentType;
  name: string;
  role?: string;
  effort: number;
  calMonths?: number;
  chargedSalary: number;   // base * effort (or gross when entered directly)
  gross: number;           // gross used for tax / net
  employeeNSSF: number;    // deducted from gross (saving)
  employerNSSF: number;    // employer contribution (saving) — never in net pay
  paye: number;
  wht: number;             // consultants only
  netPay: number;
  nssfSavings: number;     // employee + employer NSSF
  otherDeductions: Deduction[];     // resolved SACCO/levies/etc.
  otherDeductionsTotal: number;     // total of all (reduce net)
  otherSavings: number;             // subtotal of the "saving" ones (e.g. SACCO)
  fringePool: number;
  fringeUsed: number;
  fringeUnused: number;
  fringeOverspent: number;
  otherFringe: number;
  fundsRequested: number;  // budget column: chargedSalary + fringePool (or requestedFunds)
  employerCost: number;    // gross + employer NSSF + other fringe (consultants: requestedFunds)
}

// ---- Uganda PAYE (resident, monthly, UGX), marginal ----
const UGANDA_BANDS: PayeBand[] = [
  { upTo: 235000, rate: 0 },
  { upTo: 335000, rate: 0.10 },
  { upTo: 410000, rate: 0.20 },
  { upTo: null, rate: 0.30, surchargeOver: 0.10, surchargeThreshold: 10_000_000 },
];

function bandedPAYE(gross: number, bands: PayeBand[]): number {
  let tax = 0;
  let lower = 0;
  for (const b of bands) {
    const upper = b.upTo ?? Infinity;
    if (gross > lower) {
      const slice = Math.min(gross, upper) - lower;
      tax += slice * b.rate;
      if (b.surchargeOver && b.surchargeThreshold && gross > b.surchargeThreshold) {
        tax += (gross - b.surchargeThreshold) * b.surchargeOver;
      }
    }
    lower = upper;
    if (gross <= upper) break;
  }
  return tax;
}

export function computePAYE(gross: number, cfg: CompensationConfig): number {
  if (cfg.payeMethod === "none") return 0;
  if (cfg.payeMethod === "flat") return gross * (cfg.payeFlatRate ?? 0);
  return bandedPAYE(gross, cfg.payeBands ?? UGANDA_BANDS);
}

export interface PayeBandRow { from: number; to: number | null; rate: number; amountInBand: number; tax: number; note?: string }

// Marginal PAYE broken down band by band, so the calculation is transparent on a payslip.
export function payeBreakdown(gross: number, cfg: CompensationConfig): { rows: PayeBandRow[]; total: number; method: PayeMethod } {
  if (cfg.payeMethod === "none") return { rows: [], total: 0, method: "none" };
  if (cfg.payeMethod === "flat") {
    const r = cfg.payeFlatRate ?? 0;
    return { rows: [{ from: 0, to: null, rate: r, amountInBand: gross, tax: gross * r, note: "flat rate" }], total: gross * r, method: "flat" };
  }
  const bands = cfg.payeBands ?? UGANDA_BANDS;
  const rows: PayeBandRow[] = [];
  let lower = 0;
  let total = 0;
  for (const b of bands) {
    const upper = b.upTo ?? Infinity;
    const amountInBand = gross > lower ? Math.min(gross, upper) - lower : 0;
    let tax = amountInBand * b.rate;
    let note: string | undefined;
    if (b.surchargeOver && b.surchargeThreshold && gross > b.surchargeThreshold) {
      tax += (gross - b.surchargeThreshold) * b.surchargeOver;
      note = `+${Math.round(b.surchargeOver * 100)}% surcharge over ${b.surchargeThreshold.toLocaleString()}`;
    }
    if (amountInBand > 0) rows.push({ from: lower, to: b.upTo, rate: b.rate, amountInBand, tax, note });
    total += tax;
    lower = upper;
    if (gross <= upper) break;
  }
  return { rows, total, method: "uganda" };
}

// ---- Uganda Local Service Tax (LST) ----
// Annual LST by monthly-income band (UGX), capped at 100,000/yr. Disabled by
// default; when enabled it is deducted monthly (annual ÷ divisor, default 12).
export interface LstBand { upTo: number | null; annual: number }
export const UGANDA_LST_BANDS: LstBand[] = [
  { upTo: 100000, annual: 0 },
  { upTo: 200000, annual: 5000 },
  { upTo: 300000, annual: 10000 },
  { upTo: 400000, annual: 20000 },
  { upTo: 500000, annual: 30000 },
  { upTo: 600000, annual: 40000 },
  { upTo: 700000, annual: 60000 },
  { upTo: 800000, annual: 70000 },
  { upTo: 900000, annual: 80000 },
  { upTo: 1000000, annual: 90000 },
  { upTo: null, annual: 100000 },
];

export function computeLST(gross: number, cfg: CompensationConfig): number {
  if (!cfg.lstEnabled) return 0;
  const bands = cfg.lstBands ?? UGANDA_LST_BANDS;
  let annual = 0;
  for (const b of bands) { if (b.upTo == null || gross <= b.upTo) { annual = b.annual; break; } }
  const divisor = cfg.lstAnnualDivisor && cfg.lstAnnualDivisor > 0 ? cfg.lstAnnualDivisor : 12;
  return annual / divisor;
}

function computeStaff(e: StaffInput, cfg: CompensationConfig): CompResult {
  const base = e.baseSalary ?? e.grossSalary ?? 0;
  const effort = e.effortPct ?? 1;
  const chargedSalary = e.baseSalary != null ? base * effort : (e.grossSalary ?? 0);
  const gross = e.grossSalary ?? chargedSalary;

  const employeeNSSF = gross * cfg.nssfEmployeeRate;
  const employerNSSF = gross * cfg.nssfEmployerRate;
  // A per-employee flat PAYE rate overrides the org method when provided.
  const paye = e.payeOverrideRate != null ? gross * e.payeOverrideRate : computePAYE(gross, cfg);

  // Additional deductions/savings (SACCO, levies…) — all reduce net take-home.
  const otherDeductions: Deduction[] = (e.otherDeductions ?? []).map((d) => ({ label: d.label, amount: Number(d.amount) || 0, saving: Boolean(d.saving) }));
  // Local Service Tax (statutory) — prepended as a named deduction when enabled.
  const lst = computeLST(gross, cfg);
  if (lst > 0) otherDeductions.unshift({ label: "LST (statutory)", amount: lst, saving: false });
  const otherDeductionsTotal = otherDeductions.reduce((s, d) => s + d.amount, 0);
  const otherSavings = otherDeductions.filter((d) => d.saving).reduce((s, d) => s + d.amount, 0);

  // Employer NSSF and other fringe never touch net pay; employee NSSF, PAYE and
  // the additional deductions do.
  const nssfFromNet = cfg.nssfEmployeeFromFringe ? 0 : employeeNSSF;
  const netPay = gross - nssfFromNet - paye - otherDeductionsTotal;
  const nssfSavings = employeeNSSF + employerNSSF;

  const basisAmt = (e.fringeBasis ?? "base") === "base" ? base : chargedSalary;
  const computedFringe = e.fringeRatePct != null ? basisAmt * e.fringeRatePct : 0;
  const fringePool = e.fringeBudget != null ? e.fringeBudget : computedFringe;
  const otherFringe = (e.otherFringeBenefits ?? []).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const fringeUsed =
    (cfg.nssfEmployerFromFringe ? employerNSSF : 0) +
    (cfg.nssfEmployeeFromFringe ? employeeNSSF : 0) +
    otherFringe;
  const fringeUnused = Math.max(0, fringePool - fringeUsed);
  const fringeOverspent = Math.max(0, fringeUsed - fringePool);

  return {
    type: "staff", name: e.name, role: e.role, effort, calMonths: e.calMonths,
    chargedSalary, gross, employeeNSSF, employerNSSF, paye, wht: 0, netPay, nssfSavings,
    otherDeductions, otherDeductionsTotal, otherSavings,
    fringePool, fringeUsed, fringeUnused, fringeOverspent, otherFringe,
    fundsRequested: chargedSalary + fringePool,
    employerCost: gross + employerNSSF + otherFringe,
  };
}

function computeConsultant(e: ConsultantInput, cfg: CompensationConfig): CompResult {
  const funds = e.requestedFunds ?? 0;
  const wht = funds * cfg.consultantWHTRate;
  const otherDeductions: Deduction[] = (e.otherDeductions ?? []).map((d) => ({ label: d.label, amount: Number(d.amount) || 0, saving: Boolean(d.saving) }));
  const otherDeductionsTotal = otherDeductions.reduce((s, d) => s + d.amount, 0);
  const otherSavings = otherDeductions.filter((d) => d.saving).reduce((s, d) => s + d.amount, 0);
  return {
    type: "consultant", name: e.name, role: e.role, effort: e.effortPct ?? 1, calMonths: e.calMonths,
    chargedSalary: funds, gross: funds, employeeNSSF: 0, employerNSSF: 0, paye: 0, wht,
    netPay: funds - wht - otherDeductionsTotal, nssfSavings: 0,
    otherDeductions, otherDeductionsTotal, otherSavings,
    fringePool: 0, fringeUsed: 0, fringeUnused: 0,
    fringeOverspent: 0, otherFringe: 0, fundsRequested: funds, employerCost: funds,
  };
}

export function computeCompensation(e: EmployeeInput, cfg: CompensationConfig): CompResult {
  return e.type === "consultant" ? computeConsultant(e, cfg) : computeStaff(e, cfg);
}

export interface CompRollup {
  currency: string;
  headcount: number; staff: number; consultants: number;
  fundsRequested: number; netPay: number;
  employeeNSSF: number; employerNSSF: number; nssfSavings: number;
  paye: number; wht: number; taxes: number;
  otherDeductions: number; otherSavings: number;
  fringePool: number; fringeUsed: number; fringeUnused: number; otherFringe: number;
  employerCost: number; chargedSalary: number;
}

// Roll up a set of results that share a currency (employee → project → org).
// Group by currency upstream; never sum across currencies.
export function rollupCompensation(results: CompResult[], currency: string): CompRollup {
  const sum = (k: keyof CompResult) => results.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  return {
    currency,
    headcount: results.length,
    staff: results.filter((r) => r.type === "staff").length,
    consultants: results.filter((r) => r.type === "consultant").length,
    fundsRequested: sum("fundsRequested"), netPay: sum("netPay"),
    employeeNSSF: sum("employeeNSSF"), employerNSSF: sum("employerNSSF"), nssfSavings: sum("nssfSavings"),
    paye: sum("paye"), wht: sum("wht"), taxes: sum("paye") + sum("wht"),
    otherDeductions: sum("otherDeductionsTotal"), otherSavings: sum("otherSavings"),
    fringePool: sum("fringePool"), fringeUsed: sum("fringeUsed"), fringeUnused: sum("fringeUnused"),
    otherFringe: sum("otherFringe"), employerCost: sum("employerCost"), chargedSalary: sum("chargedSalary"),
  };
}

export const DEFAULT_COMP_CONFIG: CompensationConfig = {
  currency: "USD",
  nssfEmployerRate: 0.15,
  nssfEmployeeRate: 0.05,
  consultantWHTRate: 0.06,
  payeMethod: "uganda",
  nssfEmployerFromFringe: true,
  nssfEmployeeFromFringe: false,
};
