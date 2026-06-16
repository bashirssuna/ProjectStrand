import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { addTimesheetAction, decideTimesheetAction } from "@/app/actions";

export default async function TimesheetsPage({ searchParams }: { searchParams: Promise<{ added?: string; err?: string }> }) {
  const { orgId } = await requireHrOrg();
  const sp = await searchParams;
  const employees = await q<{ id: string; firstName: string; lastName: string }>(`SELECT id, first_name AS "firstName", last_name AS "lastName" FROM employee WHERE org_id=$1 AND status<>'terminated' ORDER BY last_name`, [orgId]);
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);
  const rows = await q<{ id: string; emp: string; project: string | null; workDate: string; hours: number; description: string | null; status: string; approvedBy: string | null; decisionNote: string | null }>(
    `SELECT t.id, e.first_name || ' ' || e.last_name AS emp, p.code AS project, t.work_date AS "workDate", t.hours::float, t.description, t.status,
            t.approved_by_name AS "approvedBy", t.decision_note AS "decisionNote"
     FROM timesheet t JOIN employee e ON e.id=t.employee_id LEFT JOIN project p ON p.id=t.project_id WHERE t.org_id=$1 ORDER BY t.work_date DESC LIMIT 50`, [orgId]
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title="Timesheets" subtitle="Log and approve hours" actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.added && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Timesheet logged.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Choose an employee and positive hours.</div>}

      <SectionTitle>Entries</SectionTitle>
      {rows.length === 0 ? <Empty title="No timesheets yet" hint="Log hours below." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Employee</th><th className="th text-left">Date</th><th className="th text-left">Project</th><th className="th text-right">Hours</th><th className="th text-left">Description</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="td">{t.emp}</td>
                  <td className="td whitespace-nowrap">{fmtDate(t.workDate)}</td>
                  <td className="td font-mono text-xs">{t.project ?? "—"}</td>
                  <td className="td text-right tabular-nums">{t.hours}</td>
                  <td className="td">{t.description ?? "—"}</td>
                  <td className="td"><Badge tone={t.status === "approved" ? "ok" : t.status === "rejected" ? "danger" : "warn"}>{label(t.status)}</Badge>
                    {t.status !== "submitted" && t.approvedBy && <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>by {t.approvedBy}{t.decisionNote ? ` — ${t.decisionNote}` : ""}</div>}
                  </td>
                  <td className="td text-right whitespace-nowrap">
                    {t.status === "submitted" && (
                      <form action={decideTimesheetAction} className="flex gap-1 justify-end items-center">
                        <input type="hidden" name="timesheetId" value={t.id} />
                        <input name="decisionNote" placeholder="Note (optional)" className="input" style={{ height: 30, padding: "2px 8px", width: 120 }} />
                        <button className="btn btn-sm btn-primary" name="decision" value="approved" type="submit">Approve</button>
                        <button className="btn btn-sm" name="decision" value="rejected" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reject</button>
                      </form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Monthly timesheet (save as PDF)</SectionTitle>
      <form action="/print/timesheet" method="get" target="_blank" className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
        <Field label="Employee"><select name="employeeId" required className="select"><option value="">— choose —</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select></Field>
        <Field label="Month"><input type="month" name="month" defaultValue={new Date().toISOString().slice(0, 7)} className="input" /></Field>
        <div className="self-end"><button className="btn" type="submit">🖨 Open monthly sheet</button></div>
      </form>

      <SectionTitle>Log hours</SectionTitle>
      <form action={addTimesheetAction} className="card p-4 grid sm:grid-cols-4 gap-3">
        <Field label="Employee"><select name="employeeId" required className="select"><option value="">— choose —</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select></Field>
        <Field label="Date"><input type="date" name="workDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
        <Field label="Hours"><input type="number" step="0.25" name="hours" required className="input" /></Field>
        <Field label="Project (optional)"><select name="projectId" className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></Field>
        <div className="sm:col-span-4"><Field label="Description"><input name="description" className="input" /></Field></div>
        <div className="sm:col-span-4 flex justify-end"><button className="btn btn-primary" type="submit">Log hours</button></div>
      </form>
    </div>
  );
}
