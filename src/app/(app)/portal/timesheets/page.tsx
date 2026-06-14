import { requirePortalEmployee } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { myAddTimesheetAction } from "@/app/actions";

export default async function MyTimesheets({ searchParams }: { searchParams: Promise<{ added?: string; err?: string }> }) {
  const { employeeId } = await requirePortalEmployee();
  const sp = await searchParams;
  // only projects this employee is assigned to
  const projects = await q<{ id: string; code: string; title: string }>(
    `SELECT p.id, p.code, p.title FROM project p JOIN project_member pm ON pm.project_id=p.id
     JOIN employee e ON e.user_id=pm.user_id WHERE e.id=$1 ORDER BY p.created_at DESC`, [employeeId]
  );
  const mine = await q<{ workDate: string; hours: number; project: string | null; description: string | null; status: string }>(
    `SELECT t.work_date AS "workDate", t.hours::float, p.code AS project, t.description, t.status
     FROM timesheet t LEFT JOIN project p ON p.id=t.project_id WHERE t.employee_id=$1 ORDER BY t.work_date DESC LIMIT 30`, [employeeId]
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title="My timesheets" subtitle="Log the hours you work" />
      {sp.added && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Hours logged.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter positive hours.</div>}

      <SectionTitle>Log hours</SectionTitle>
      <form action={myAddTimesheetAction} className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
        <Field label="Date"><input type="date" name="workDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
        <Field label="Hours"><input type="number" step="0.25" name="hours" required className="input" /></Field>
        <Field label="Project (optional)"><select name="projectId" className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></Field>
        <div className="sm:col-span-3"><Field label="Description"><input name="description" className="input" placeholder="What did you work on?" /></Field></div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Log hours</button></div>
      </form>

      <SectionTitle>My recent entries</SectionTitle>
      {mine.length === 0 ? <Empty title="No timesheets yet" hint="Log your first entry above." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Date</th><th className="th text-right">Hours</th><th className="th text-left">Project</th><th className="th text-left">Description</th><th className="th text-left">Status</th></tr></thead>
            <tbody>{mine.map((t, i) => (<tr key={i}><td className="td">{fmtDate(t.workDate)}</td><td className="td text-right tabular-nums">{t.hours}</td><td className="td font-mono text-xs">{t.project ?? "—"}</td><td className="td">{t.description ?? "—"}</td><td className="td"><Badge tone={t.status === "approved" ? "ok" : t.status === "rejected" ? "danger" : "warn"}>{label(t.status)}</Badge></td></tr>))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
