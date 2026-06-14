import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";

const round2 = (n: number | string) => { const x = Number(n) || 0; return Math.round((x + Number.EPSILON) * 100) / 100; };

// ---------------------------------------------------------------------------
// Leave balance: annual entitlement minus approved annual-leave days this year.
// ---------------------------------------------------------------------------
export async function leaveBalance(employeeId: string): Promise<{ entitlement: number; taken: number; pending: number; remaining: number }> {
  const emp = await one<{ ent: number }>(`SELECT annual_leave_days::float ent FROM employee WHERE id=$1`, [employeeId]);
  const entitlement = Number(emp?.ent ?? 0);
  const year = new Date().getFullYear();
  const taken = (await one<{ s: number }>(
    `SELECT COALESCE(SUM(days),0)::float s FROM leave_request
     WHERE employee_id=$1 AND leave_type='annual' AND status='approved' AND EXTRACT(YEAR FROM start_date)=$2`,
    [employeeId, year]
  ))?.s ?? 0;
  const pending = (await one<{ s: number }>(
    `SELECT COALESCE(SUM(days),0)::float s FROM leave_request
     WHERE employee_id=$1 AND leave_type='annual' AND status='pending' AND EXTRACT(YEAR FROM start_date)=$2`,
    [employeeId, year]
  ))?.s ?? 0;
  return { entitlement, taken: round2(taken), pending: round2(pending), remaining: round2(entitlement - taken) };
}

// ---------------------------------------------------------------------------
// Payroll calculation for ONE employee. Pulls the components that apply (the
// org defaults, plus/minus any per-employee overrides) and computes earnings,
// gross, deductions, net — with a full line breakdown for the payslip.
// Percentages can be of 'basic' or 'gross'. To keep it well-defined, gross-based
// components are computed against (basic + flat/basic-percent earnings).
// ---------------------------------------------------------------------------
export type PayComputation = {
  basic: number; earnings: number; gross: number; deductions: number; net: number;
  lines: { name: string; kind: "earning" | "deduction"; amount: number }[];
};

export async function computePay(employeeId: string): Promise<PayComputation> {
  const emp = (await one<{ basic: number }>(`SELECT basic_salary::float basic FROM employee WHERE id=$1`, [employeeId]))!;
  const basic = Number(emp.basic);

  // org default components + any explicitly assigned to this employee, with overrides
  const components = await q<{
    id: string; name: string; kind: string; amountType: string; rate: number; basis: string;
    appliesDefault: boolean; overrideRate: number | null;
  }>(
    `SELECT pc.id, pc.name, pc.kind, pc.amount_type AS "amountType", pc.rate::float, pc.basis,
            pc.applies_default AS "appliesDefault",
            (SELECT override_rate::float FROM employee_pay_component epc WHERE epc.component_id=pc.id AND epc.employee_id=$1::text) AS "overrideRate"
     FROM pay_component pc
     WHERE pc.org_id=(SELECT org_id FROM employee WHERE id=$2::text) AND pc.active=true
       AND (pc.applies_default=true OR EXISTS (SELECT 1 FROM employee_pay_component e WHERE e.component_id=pc.id AND e.employee_id=$3::text))
     ORDER BY CASE pc.kind WHEN 'earning' THEN 0 ELSE 1 END, pc.name`,
    [employeeId, employeeId, employeeId]
  );

  const lines: PayComputation["lines"] = [];

  // First pass: earnings (basic-based or flat) to establish gross.
  let earnings = 0;
  for (const c of components.filter((c) => c.kind === "earning")) {
    const rate = c.overrideRate ?? Number(c.rate);
    const amt = c.amountType === "percent" ? round2((c.basis === "gross" ? basic : basic) * (rate / 100)) : round2(rate);
    earnings += amt;
    lines.push({ name: c.name, kind: "earning", amount: amt });
  }
  const gross = round2(basic + earnings);

  // Second pass: deductions (now gross is known for gross-based percentages).
  let deductions = 0;
  for (const c of components.filter((c) => c.kind === "deduction")) {
    const rate = c.overrideRate ?? Number(c.rate);
    const base = c.basis === "gross" ? gross : basic;
    const amt = c.amountType === "percent" ? round2(base * (rate / 100)) : round2(rate);
    deductions += amt;
    lines.push({ name: c.name, kind: "deduction", amount: amt });
  }

  return {
    basic: round2(basic), earnings: round2(earnings), gross,
    deductions: round2(deductions), net: round2(gross - deductions), lines,
  };
}

// Builds (or rebuilds) a draft payroll run for a period: a payslip per active
// employee with its line breakdown. Re-running clears and recomputes the draft.
export async function buildPayrollRun(orgId: string, periodLabel: string, by: { id: string; name: string }): Promise<{ runId: string; employees: number }> {
  let run = await one<{ id: string; status: string }>(`SELECT id, status FROM payroll_run WHERE org_id=$1 AND period_label=$2`, [orgId, periodLabel]);
  if (run && run.status === "finalised") throw new Error("This payroll period is already finalised.");

  const runId = run?.id ?? id("pr");
  if (!run) {
    await q(`INSERT INTO payroll_run (id, org_id, period_label, run_date, status, created_by, created_by_name)
             VALUES ($1,$2,$3,$4,'draft',$5,$6)`,
      [runId, orgId, periodLabel, new Date().toISOString().slice(0, 10), by.id, by.name]);
  } else {
    // clear existing draft payslips for a clean recompute
    await q(`DELETE FROM payslip WHERE run_id=$1`, [runId]);
  }

  const employees = await q<{ id: string; currency: string }>(
    `SELECT id, currency FROM employee WHERE org_id=$1 AND status<>'terminated' AND basic_salary > 0`, [orgId]
  );
  let tGross = 0, tDed = 0, tNet = 0;
  for (const e of employees) {
    const c = await computePay(e.id);
    const slipId = id("ps");
    await q(`INSERT INTO payslip (id, run_id, employee_id, basic, earnings, gross, deductions, net, currency)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [slipId, runId, e.id, c.basic, c.earnings, c.gross, c.deductions, c.net, e.currency]);
    for (const l of c.lines) {
      await q(`INSERT INTO payslip_line (id, payslip_id, name, kind, amount) VALUES ($1,$2,$3,$4,$5)`, [id("psl"), slipId, l.name, l.kind, l.amount]);
    }
    tGross += c.gross; tDed += c.deductions; tNet += c.net;
  }
  await q(`UPDATE payroll_run SET total_gross=$2, total_deductions=$3, total_net=$4 WHERE id=$1`,
    [runId, round2(tGross), round2(tDed), round2(tNet)]);
  return { runId, employees: employees.length };
}

// Finalising a payroll run marks it locked. (Ledger posting is deferred until
// the Finance module is closed out — payroll will then debit salary expense,
// credit payroll liabilities / cash. The hook is here and ready.)
export async function finalisePayrollRun(orgId: string, runId: string): Promise<void> {
  const run = await one<{ status: string }>(`SELECT status FROM payroll_run WHERE id=$1 AND org_id=$2`, [runId, orgId]);
  if (!run) throw new Error("Run not found.");
  if (run.status === "finalised") return;
  await q(`UPDATE payroll_run SET status='finalised' WHERE id=$1`, [runId]);
  // FINANCE HOOK (deferred): post salary expense + statutory liabilities here.
}

// ---------------------------------------------------------------------------
// Create a restricted self-service login for an employee and email them an
// invite (set-password) link. The account is flagged is_staff=true so the app
// shows them only the staff portal. Reuses the existing invite token flow.
// ---------------------------------------------------------------------------
export async function createEmployeeLogin(employeeId: string): Promise<{ emailStatus: "sent" | "failed" | "exists"; emailError?: string }> {
  const emp = await one<{ orgId: string; first: string; last: string; email: string | null; userId: string | null }>(
    `SELECT org_id AS "orgId", first_name AS first, last_name AS last, email, user_id AS "userId" FROM employee WHERE id=$1`, [employeeId]
  );
  if (!emp) throw new Error("Employee not found.");
  if (emp.userId) return { emailStatus: "exists" };
  if (!emp.email) throw new Error("Add an email address to this employee before creating a login.");

  // reuse an existing account with this email, or create one
  let target = await one<{ id: string }>(`SELECT id FROM app_user WHERE email=$1`, [emp.email]);
  if (!target) {
    const uid = id("usr");
    await q(`INSERT INTO app_user (id, email, name, status, is_staff) VALUES ($1,$2,$3,'invited',true)`,
      [uid, emp.email, `${emp.first} ${emp.last}`]);
    await q(`INSERT INTO user_profile (id, user_id) VALUES ($1,$2)`, [id("up"), uid]);
    target = { id: uid };
  } else {
    await q(`UPDATE app_user SET is_staff=true WHERE id=$1`, [target.id]);
  }
  // ensure org membership (as a plain member role)
  const memberRole = await one<{ id: string }>(`SELECT id FROM role WHERE org_id=$1 AND key='member' LIMIT 1`, [emp.orgId]);
  if (memberRole) {
    await q(`INSERT INTO org_membership (id, org_id, user_id, role_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [id("om"), emp.orgId, target.id, memberRole.id]);
  }
  await q(`UPDATE employee SET user_id=$2 WHERE id=$1`, [employeeId, target.id]);

  const { issuePasswordToken } = await import("@/server/services/accounts");
  const issued = await issuePasswordToken(target.id, "invite", emp.email, `${emp.first} ${emp.last}`);
  return { emailStatus: issued.emailStatus, emailError: issued.emailError };
}

// Look up the employee record for a logged-in staff user (if any).
export async function employeeForUser(userId: string): Promise<{ id: string; orgId: string; firstName: string; lastName: string } | null> {
  return one(`SELECT id, org_id AS "orgId", first_name AS "firstName", last_name AS "lastName" FROM employee WHERE user_id=$1`, [userId]);
}
