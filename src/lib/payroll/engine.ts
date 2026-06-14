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
}

export interface ConsultantInput {
  type: "consultant";
  name: string;
  role?: string;
  requestedFunds: number;
  effortPct?: number;
  calMonths?: number;
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

function computeStaff(e: StaffInput, cfg: CompensationConfig): CompResult {
  const base = e.baseSalary ?? e.grossSalary ?? 0;
  const effort = e.effortPct ?? 1;
  const chargedSalary = e.baseSalary != null ? base * effort : (e.grossSalary ?? 0);
  const gross = e.grossSalary ?? chargedSalary;

  const employeeNSSF = gross * cfg.nssfEmployeeRate;
  const employerNSSF = gross * cfg.nssfEmployerRate;
  const paye = computePAYE(gross, cfg);

  // Employer NSSF and other fringe never touch net pay.
  const nssfFromNet = cfg.nssfEmployeeFromFringe ? 0 : employeeNSSF;
  const netPay = gross - nssfFromNet - paye;
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
    fringePool, fringeUsed, fringeUnused, fringeOverspent, otherFringe,
    fundsRequested: chargedSalary + fringePool,
    employerCost: gross + employerNSSF + otherFringe,
  };
}

function computeConsultant(e: ConsultantInput, cfg: CompensationConfig): CompResult {
  const funds = e.requestedFunds ?? 0;
  const wht = funds * cfg.consultantWHTRate;
  return {
    type: "consultant", name: e.name, role: e.role, effort: e.effortPct ?? 1, calMonths: e.calMonths,
    chargedSalary: funds, gross: funds, employeeNSSF: 0, employerNSSF: 0, paye: 0, wht,
    netPay: funds - wht, nssfSavings: 0, fringePool: 0, fringeUsed: 0, fringeUnused: 0,
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
    fringePool: sum("fringePool"), fringeUsed: sum("fringeUsed"), fringeUnused: sum("fringeUnused"),
    otherFringe: sum("otherFringe"), employerCost: sum("employerCost"), chargedSalary: sum("chargedSalary"),
  };
}

export const DEFAULT_COMP_CONFIG: CompensationConfig = {
  currency: "UGX",
  nssfEmployerRate: 0.15,
  nssfEmployeeRate: 0.05,
  consultantWHTRate: 0.06,
  payeMethod: "uganda",
  nssfEmployerFromFringe: true,
  nssfEmployeeFromFringe: false,
};
