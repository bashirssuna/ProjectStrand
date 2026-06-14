import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import {
  computeCompensation, rollupCompensation,
  type CompensationConfig, type EmployeeInput, type CompResult, type CompRollup, type PayeMethod,
} from "@/lib/payroll/engine";

// ---------------------------------------------------------------------------
// Configurable rates/methods, one row per organisation. Percentages are stored
// as whole numbers (15 = 15%); the engine wants fractions, so we divide by 100
// when building its config. Defaults match the institution's stated practice
// (employer NSSF 15%, employee NSSF 5%, consultant WHT 6%, Uganda PAYE bands).
// ---------------------------------------------------------------------------
export type CompConfigRow = {
  nssfEmployerPct: number; nssfEmployeePct: number; consultantWhtPct: number;
  payeMethod: PayeMethod; payeFlatPct: number; payeBands: string | null;
  nssfEmployerFromFringe: boolean; nssfEmployeeFromFringe: boolean;
  lstEnabled: boolean; lstBands: string | null; lstDivisor: number;
};

export const COMP_CONFIG_DEFAULTS: CompConfigRow = {
  nssfEmployerPct: 10, nssfEmployeePct: 5, consultantWhtPct: 6,
  payeMethod: "uganda", payeFlatPct: 0, payeBands: null,
  nssfEmployerFromFringe: true, nssfEmployeeFromFringe: false,
  lstEnabled: false, lstBands: null, lstDivisor: 12,
};

export async function getCompConfig(orgId: string): Promise<CompConfigRow> {
  const row = await one<CompConfigRow>(
    `SELECT nssf_employer_pct::float AS "nssfEmployerPct", nssf_employee_pct::float AS "nssfEmployeePct",
            consultant_wht_pct::float AS "consultantWhtPct", paye_method AS "payeMethod",
            paye_flat_pct::float AS "payeFlatPct", paye_bands AS "payeBands",
            nssf_employer_from_fringe AS "nssfEmployerFromFringe", nssf_employee_from_fringe AS "nssfEmployeeFromFringe",
            lst_enabled AS "lstEnabled", lst_bands AS "lstBands", lst_divisor::int AS "lstDivisor"
     FROM comp_config WHERE org_id=$1`, [orgId]
  );
  return row ?? { ...COMP_CONFIG_DEFAULTS };
}

export async function upsertCompConfig(orgId: string, c: CompConfigRow): Promise<void> {
  await q(
    `INSERT INTO comp_config
       (org_id, nssf_employer_pct, nssf_employee_pct, consultant_wht_pct, paye_method, paye_flat_pct, paye_bands, nssf_employer_from_fringe, nssf_employee_from_fringe, lst_enabled, lst_bands, lst_divisor, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (org_id) DO UPDATE SET
       nssf_employer_pct=$2, nssf_employee_pct=$3, consultant_wht_pct=$4, paye_method=$5,
       paye_flat_pct=$6, paye_bands=$7, nssf_employer_from_fringe=$8, nssf_employee_from_fringe=$9,
       lst_enabled=$10, lst_bands=$11, lst_divisor=$12, updated_at=now()`,
    [orgId, c.nssfEmployerPct, c.nssfEmployeePct, c.consultantWhtPct, c.payeMethod,
     c.payeFlatPct, c.payeBands, c.nssfEmployerFromFringe, c.nssfEmployeeFromFringe,
     c.lstEnabled, c.lstBands, c.lstDivisor]
  );
}

function toEngineConfig(currency: string, c: CompConfigRow): CompensationConfig {
  let bands: CompensationConfig["payeBands"];
  if (c.payeBands) { try { bands = JSON.parse(c.payeBands); } catch { /* keep undefined → engine defaults */ } }
  let lstBands: CompensationConfig["lstBands"];
  if (c.lstBands) { try { lstBands = JSON.parse(c.lstBands); } catch { /* keep undefined → engine defaults */ } }
  return {
    currency,
    nssfEmployerRate: c.nssfEmployerPct / 100,
    nssfEmployeeRate: c.nssfEmployeePct / 100,
    consultantWHTRate: c.consultantWhtPct / 100,
    payeMethod: c.payeMethod,
    payeFlatRate: c.payeFlatPct / 100,
    payeBands: bands,
    nssfEmployerFromFringe: c.nssfEmployerFromFringe,
    nssfEmployeeFromFringe: c.nssfEmployeeFromFringe,
    lstEnabled: c.lstEnabled,
    lstBands,
    lstAnnualDivisor: c.lstDivisor,
  };
}

// ---------------------------------------------------------------------------
// Per-employee compensation records.
// ---------------------------------------------------------------------------
export type EmpCompRow = {
  id: string; employeeId: string; projectId: string | null; employmentType: "staff" | "consultant";
  currency: string; grossSalary: number | null; baseSalary: number | null; effortPct: number;
  calMonths: number | null; fringeAmount: number | null; fringeRatePct: number | null; fringeBasis: string;
  requestedFunds: number | null; benefits: string; note: string | null;
  payeOverridePct: number | null; deductions: string;
  firstName: string; lastName: string; prefix: string | null; jobTitle: string | null;
  projectCode: string | null; projectTitle: string | null;
};

const EMP_COMP_SELECT = `
  SELECT ec.id, ec.employee_id AS "employeeId", ec.project_id AS "projectId", ec.employment_type AS "employmentType",
         ec.currency, ec.gross_salary::float AS "grossSalary", ec.base_salary::float AS "baseSalary",
         ec.effort_pct::float AS "effortPct", ec.cal_months::float AS "calMonths",
         ec.fringe_amount::float AS "fringeAmount", ec.fringe_rate_pct::float AS "fringeRatePct",
         ec.fringe_basis AS "fringeBasis", ec.requested_funds::float AS "requestedFunds",
         ec.benefits, ec.note, ec.paye_override_pct::float AS "payeOverridePct", ec.deductions,
         e.first_name AS "firstName", e.last_name AS "lastName", e.prefix, e.job_title AS "jobTitle",
         p.code AS "projectCode", p.title AS "projectTitle"
  FROM employee_compensation ec
  JOIN employee e ON e.id = ec.employee_id
  LEFT JOIN project p ON p.id = ec.project_id`;

export type ParsedBenefit = { label: string; amount: number };
export type DeductionKind = "pct_deduction" | "pct_saving" | "flat_deduction" | "flat_saving";
export type ParsedDeduction = { label: string; value: number; kind: DeductionKind };

function parseBenefits(raw: string): ParsedBenefit[] {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr.map((b) => ({ label: String(b.label ?? ""), amount: Number(b.amount) || 0 })).filter((b) => b.label);
  } catch { return []; }
}

const DEDUCTION_KINDS: DeductionKind[] = ["pct_deduction", "pct_saving", "flat_deduction", "flat_saving"];

function parseDeductionDefs(raw: string): ParsedDeduction[] {
  try {
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .map((d) => ({ label: String(d.label ?? ""), value: Number(d.value) || 0, kind: (DEDUCTION_KINDS.includes(d.kind) ? d.kind : "pct_deduction") as DeductionKind }))
      .filter((d) => d.label);
  } catch { return []; }
}

// Resolve stored deduction definitions into absolute amounts given the gross.
function resolveDeductions(defs: ParsedDeduction[], gross: number) {
  return defs.map((d) => ({
    label: d.label,
    amount: d.kind.startsWith("pct") ? gross * (d.value / 100) : d.value,
    saving: d.kind.endsWith("saving"),
  }));
}

// Gross actually paid (mirrors the engine) — needed to resolve % deductions.
function grossOf(r: EmpCompRow): number {
  const effort = (r.effortPct ?? 100) / 100;
  const base = r.baseSalary ?? r.grossSalary ?? 0;
  const charged = r.baseSalary != null ? base * effort : (r.grossSalary ?? 0);
  return r.grossSalary ?? charged;
}

function toEngineInput(r: EmpCompRow): EmployeeInput {
  const name = `${r.prefix ? r.prefix + " " : ""}${r.firstName} ${r.lastName}`.trim();
  const effort = (r.effortPct ?? 100) / 100;
  const deductions = resolveDeductions(parseDeductionDefs(r.deductions), grossOf(r));
  if (r.employmentType === "consultant") {
    return { type: "consultant", name, role: r.jobTitle ?? undefined, requestedFunds: r.requestedFunds ?? 0, effortPct: effort, calMonths: r.calMonths ?? undefined, otherDeductions: deductions };
  }
  return {
    type: "staff", name, role: r.jobTitle ?? undefined,
    grossSalary: r.grossSalary ?? undefined,
    baseSalary: r.baseSalary ?? undefined,
    effortPct: effort,
    calMonths: r.calMonths ?? undefined,
    fringeBudget: r.fringeAmount ?? undefined,
    fringeRatePct: r.fringeRatePct != null ? r.fringeRatePct / 100 : undefined,
    fringeBasis: (r.fringeBasis as "base" | "charged") || "base",
    otherFringeBenefits: parseBenefits(r.benefits).map((b) => ({ label: b.label, amount: b.amount })),
    payeOverrideRate: r.payeOverridePct != null ? r.payeOverridePct / 100 : undefined,
    otherDeductions: deductions,
  };
}

export type EmpCompComputed = { row: EmpCompRow; result: CompResult; benefits: ParsedBenefit[]; deductionDefs: ParsedDeduction[] };

export async function getEmployeeComp(employeeId: string): Promise<(EmpCompComputed & { config: CompConfigRow }) | null> {
  const row = await one<EmpCompRow>(`${EMP_COMP_SELECT} WHERE ec.employee_id=$1`, [employeeId]);
  if (!row) return null;
  const owner = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM employee WHERE id=$1`, [employeeId]);
  const config = await getCompConfig(owner!.orgId);
  const result = computeCompensation(toEngineInput(row), toEngineConfig(row.currency, config));
  return { row, result, benefits: parseBenefits(row.benefits), deductionDefs: parseDeductionDefs(row.deductions), config };
}

export type UpsertCompInput = {
  projectId: string | null;
  employmentType: "staff" | "consultant";
  currency: string;
  grossSalary: number | null;
  baseSalary: number | null;
  effortPct: number;
  calMonths: number | null;
  fringeAmount: number | null;
  fringeRatePct: number | null;
  fringeBasis: "base" | "charged";
  requestedFunds: number | null;
  benefits: ParsedBenefit[];
  payeOverridePct: number | null;
  deductions: ParsedDeduction[];
  note: string | null;
};

export async function upsertEmployeeComp(orgId: string, employeeId: string, input: UpsertCompInput): Promise<void> {
  const existing = await one<{ id: string }>(`SELECT id FROM employee_compensation WHERE employee_id=$1`, [employeeId]);
  const benefitsJson = JSON.stringify(input.benefits ?? []);
  const deductionsJson = JSON.stringify(input.deductions ?? []);
  if (existing) {
    await q(
      `UPDATE employee_compensation SET project_id=$2, employment_type=$3, currency=$4, gross_salary=$5,
         base_salary=$6, effort_pct=$7, cal_months=$8, fringe_amount=$9, fringe_rate_pct=$10,
         fringe_basis=$11, requested_funds=$12, benefits=$13, note=$14, paye_override_pct=$15, deductions=$16, updated_at=now()
       WHERE id=$1`,
      [existing.id, input.projectId, input.employmentType, input.currency, input.grossSalary,
       input.baseSalary, input.effortPct, input.calMonths, input.fringeAmount, input.fringeRatePct,
       input.fringeBasis, input.requestedFunds, benefitsJson, input.note, input.payeOverridePct, deductionsJson]
    );
  } else {
    await q(
      `INSERT INTO employee_compensation
         (id, org_id, employee_id, project_id, employment_type, currency, gross_salary, base_salary,
          effort_pct, cal_months, fringe_amount, fringe_rate_pct, fringe_basis, requested_funds, benefits, note, paye_override_pct, deductions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id("ecmp"), orgId, employeeId, input.projectId, input.employmentType, input.currency, input.grossSalary,
       input.baseSalary, input.effortPct, input.calMonths, input.fringeAmount, input.fringeRatePct,
       input.fringeBasis, input.requestedFunds, benefitsJson, input.note, input.payeOverridePct, deductionsJson]
    );
  }
}

// ---------------------------------------------------------------------------
// Roll-ups. Always grouped by currency — a UGX project and a USD project are
// never summed into one meaningless figure.
// ---------------------------------------------------------------------------
function group(computed: EmpCompComputed[]): CompRollup[] {
  const byCur = new Map<string, CompResult[]>();
  for (const c of computed) {
    const k = c.row.currency || "USD";
    if (!byCur.has(k)) byCur.set(k, []);
    byCur.get(k)!.push(c.result);
  }
  return [...byCur.entries()].map(([cur, rs]) => rollupCompensation(rs, cur));
}

async function computeRows(where: string, param: string): Promise<EmpCompComputed[]> {
  const rows = await q<EmpCompRow>(`${EMP_COMP_SELECT} ${where} ORDER BY p.code NULLS LAST, e.last_name, e.first_name`, [param]);
  if (rows.length === 0) return [];
  const orgId = (await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM employee WHERE id=$1`, [rows[0].employeeId]))!.orgId;
  const config = await getCompConfig(orgId);
  return rows.map((row) => ({ row, result: computeCompensation(toEngineInput(row), toEngineConfig(row.currency, config)), benefits: parseBenefits(row.benefits), deductionDefs: parseDeductionDefs(row.deductions) }));
}

export async function orgCompensation(orgId: string): Promise<{ byCurrency: CompRollup[]; rows: EmpCompComputed[] }> {
  const rows = await computeRows(`WHERE ec.org_id=$1`, orgId);
  return { byCurrency: group(rows), rows };
}

export async function projectCompensation(projectId: string): Promise<{ byCurrency: CompRollup[]; rows: EmpCompComputed[] }> {
  const rows = await computeRows(`WHERE ec.project_id=$1`, projectId);
  return { byCurrency: group(rows), rows };
}
