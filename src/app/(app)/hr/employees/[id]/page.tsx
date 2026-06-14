import Link from "next/link";
import { requireHrOrg } from "../../_guard";
import { q, one } from "@/server/db";
import { leaveBalance, computePay } from "@/server/services/hr";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { updateEmployeeAction, assignEmployeeDepartmentAction, createEmployeeLoginAction } from "@/app/actions";
import { dateInput } from "@/lib/format";

export default async function EmployeeDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; login?: string; loginerr?: string }> }) {
  const { id } = await params;
  const { orgId } = await requireHrOrg();
  const sp = await searchParams;
  const e = await one<{
    id: string; staffNo: string | null; firstName: string; lastName: string; email: string | null; phone: string | null;
    jobTitle: string | null; department: string | null; departmentId: string | null; contractType: string; startDate: string | null; endDate: string | null;
    basicSalary: number; currency: string; bankName: string | null; bankAccount: string | null; bankBranch: string | null;
    mobileMoney: string | null; annualLeaveDays: number; status: string; userId: string | null;
  }>(
    `SELECT id, staff_no AS "staffNo", first_name AS "firstName", last_name AS "lastName", email, phone,
            job_title AS "jobTitle", department, department_id AS "departmentId", contract_type AS "contractType", start_date AS "startDate", end_date AS "endDate",
            basic_salary::float AS "basicSalary", currency, bank_name AS "bankName", bank_account AS "bankAccount",
            bank_branch AS "bankBranch", mobile_money AS "mobileMoney", annual_leave_days::float AS "annualLeaveDays", status, user_id AS "userId"
     FROM employee WHERE id=$1 AND org_id=$2`, [id, orgId]
  );
  if (!e) return <Empty title="Employee not found" hint="They may have been removed." />;
  const departments = await q<{ id: string; name: string }>(`SELECT id, name FROM department WHERE org_id=$1 ORDER BY name`, [orgId]);
  const lb = await leaveBalance(id);
  const pay = await computePay(id);
  const recentLeave = await q<{ leaveType: string; startDate: string; endDate: string; days: number; status: string }>(
    `SELECT leave_type AS "leaveType", start_date AS "startDate", end_date AS "endDate", days::float, status FROM leave_request WHERE employee_id=$1 ORDER BY start_date DESC LIMIT 5`, [id]
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title={`${e.firstName} ${e.lastName}`} subtitle={`${e.jobTitle ?? "—"}${e.department ? ` · ${e.department}` : ""}`} actions={<Link href="/hr/employees" className="btn btn-sm">← Employees</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.login === "sent" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Self-service login created — an invite email with a set-password link has been sent.</div>}
      {sp.login === "exists" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)", borderColor: "var(--border)" }}>This employee already has a login.</div>}
      {sp.login === "failed" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>Login created, but the invite email could not be sent. They can use “forgot password” to set one.</div>}
      {sp.loginerr && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.loginerr)}</div>}

      {/* Login + department */}
      <div className="grid sm:grid-cols-2 gap-4 mb-6">
        <div className="card p-4">
          <div className="font-medium mb-2">Self-service login</div>
          {e.userId ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>This employee has a portal login linked. They can sign in to fill timesheets, request leave, raise purchase requests, and manage their own profile &amp; documents.</p>
          ) : (
            <>
              <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>{e.email ? "Create a restricted portal login and email them an invite to set a password." : "Add an email address (below) before creating a login."}</p>
              {e.email && <form action={createEmployeeLoginAction}><input type="hidden" name="employeeId" value={e.id} /><button className="btn btn-primary btn-sm" type="submit">Create portal login</button></form>}
            </>
          )}
        </div>
        <div className="card p-4">
          <div className="font-medium mb-2">Department</div>
          <form action={assignEmployeeDepartmentAction} className="flex items-end gap-2">
            <input type="hidden" name="employeeId" value={e.id} />
            <select name="departmentId" defaultValue={e.departmentId ?? ""} className="select">
              <option value="">— unassigned —</option>
              {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <button className="btn btn-sm" type="submit">Assign</button>
          </form>
          {departments.length === 0 && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>No departments yet — create them under HR → Departments.</p>}
        </div>
      </div>

      <div className="grid sm:grid-cols-4 gap-3 mb-6">
        <div className="card p-3"><div className="label">Basic salary</div><div className="font-semibold tabular-nums">{money(e.basicSalary, e.currency)}</div></div>
        <div className="card p-3"><div className="label">Net pay (computed)</div><div className="font-semibold tabular-nums">{money(pay.net, e.currency)}</div></div>
        <div className="card p-3"><div className="label">Leave remaining</div><div className="font-semibold">{lb.remaining} / {lb.entitlement} days</div></div>
        <div className="card p-3"><div className="label">Status</div><div className="font-semibold">{label(e.status)}</div></div>
      </div>

      {/* current pay breakdown */}
      <SectionTitle>Current pay breakdown</SectionTitle>
      <div className="card overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <tbody>
            <tr><td className="td">Basic salary</td><td className="td text-right tabular-nums">{money(pay.basic, e.currency)}</td></tr>
            {pay.lines.filter((l) => l.kind === "earning").map((l, i) => <tr key={`e${i}`}><td className="td">+ {l.name}</td><td className="td text-right tabular-nums">{money(l.amount, e.currency)}</td></tr>)}
            <tr style={{ fontWeight: 600 }}><td className="td">Gross</td><td className="td text-right tabular-nums">{money(pay.gross, e.currency)}</td></tr>
            {pay.lines.filter((l) => l.kind === "deduction").map((l, i) => <tr key={`d${i}`}><td className="td">− {l.name}</td><td className="td text-right tabular-nums">({money(l.amount, e.currency)})</td></tr>)}
            <tr style={{ fontWeight: 700 }}><td className="td">Net pay</td><td className="td text-right tabular-nums">{money(pay.net, e.currency)}</td></tr>
          </tbody>
        </table>
      </div>

      {/* recent leave */}
      <SectionTitle>Recent leave</SectionTitle>
      {recentLeave.length === 0 ? <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>No leave recorded.</p> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Type</th><th className="th text-left">From</th><th className="th text-left">To</th><th className="th text-right">Days</th><th className="th text-left">Status</th></tr></thead>
            <tbody>{recentLeave.map((l, i) => (
              <tr key={i}><td className="td">{label(l.leaveType)}</td><td className="td">{fmtDate(l.startDate)}</td><td className="td">{fmtDate(l.endDate)}</td><td className="td text-right">{l.days}</td><td className="td"><Badge tone={l.status === "approved" ? "ok" : l.status === "rejected" ? "danger" : "warn"}>{label(l.status)}</Badge></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {/* edit */}
      <SectionTitle>Employment details</SectionTitle>
      <form action={updateEmployeeAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <input type="hidden" name="employeeId" value={e.id} />
        <Field label="Job title"><input name="jobTitle" defaultValue={e.jobTitle ?? ""} className="input" /></Field>
        <Field label="Department"><input name="department" defaultValue={e.department ?? ""} className="input" /></Field>
        <Field label="Contract type">
          <select name="contractType" defaultValue={e.contractType} className="select"><option value="permanent">Permanent</option><option value="fixed_term">Fixed term</option><option value="casual">Casual</option><option value="consultant">Consultant</option><option value="intern">Intern</option></select>
        </Field>
        <Field label="Basic salary"><input type="number" step="0.01" name="basicSalary" defaultValue={e.basicSalary} className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue={e.currency} className="input" /></Field>
        <Field label="Status">
          <select name="status" defaultValue={e.status} className="select"><option value="active">Active</option><option value="on_leave">On leave</option><option value="terminated">Terminated</option></select>
        </Field>
        <Field label="Email"><input name="email" defaultValue={e.email ?? ""} className="input" /></Field>
        <Field label="Phone"><input name="phone" defaultValue={e.phone ?? ""} className="input" /></Field>
        <Field label="Annual leave (days)"><input type="number" step="0.5" name="annualLeaveDays" defaultValue={e.annualLeaveDays} className="input" /></Field>
        <Field label="Bank name"><input name="bankName" defaultValue={e.bankName ?? ""} className="input" /></Field>
        <Field label="Bank account"><input name="bankAccount" defaultValue={e.bankAccount ?? ""} className="input" /></Field>
        <Field label="Bank branch"><input name="bankBranch" defaultValue={e.bankBranch ?? ""} className="input" /></Field>
        <Field label="Mobile money"><input name="mobileMoney" defaultValue={e.mobileMoney ?? ""} className="input" /></Field>
        <Field label="Start date"><input type="date" name="startDate" defaultValue={dateInput(e.startDate)} className="input" /></Field>
        <Field label="End date"><input type="date" name="endDate" defaultValue={dateInput(e.endDate)} className="input" /></Field>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Save changes</button></div>
      </form>
    </div>
  );
}
