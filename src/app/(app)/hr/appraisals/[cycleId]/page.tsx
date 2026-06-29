import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHrOrg } from "../../_guard";
import { q } from "@/server/db";
import { getCycle, listAppraisals, ratingLabel } from "@/server/services/appraisals";
import { PageHeader, SectionTitle, Field, StatusBadge, Badge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { createAppraisalAction, setCycleStatusAction } from "@/app/actions";

const CYCLE_STATUSES = ["draft", "open", "closed"];

export default async function CycleDetailPage({ params, searchParams }: { params: Promise<{ cycleId: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const { cycleId } = await params;
  const sp = await searchParams;
  const cycle = await getCycle(orgId, cycleId);
  if (!cycle) notFound();
  const [appraisals, employees] = await Promise.all([
    listAppraisals(orgId, cycleId),
    q<{ id: string; name: string; jobTitle: string | null }>(
      `SELECT id, (first_name || ' ' || last_name) AS name, job_title AS "jobTitle" FROM employee WHERE org_id=$1 AND status != 'terminated' ORDER BY first_name, last_name`, [orgId]),
  ]);
  const appraisedIds = new Set(appraisals.map((a) => a.employeeId));
  const remaining = employees.filter((e) => !appraisedIds.has(e.id));

  return (
    <div className="max-w-4xl">
      <PageHeader title={cycle.name} subtitle={`${label(cycle.kind)} review${cycle.periodStart ? ` · ${fmtDate(cycle.periodStart)}${cycle.periodEnd ? `–${fmtDate(cycle.periodEnd)}` : ""}` : ""}`} actions={<Link href="/hr/appraisals" className="btn btn-sm">← Cycles</Link>} />
      {sp.err === "emp" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Pick an employee to appraise.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <StatusBadge status={cycle.status} />
        {cycle.dueDate && <span className="text-sm" style={{ color: "var(--muted)" }}>Due {fmtDate(cycle.dueDate)}</span>}
        <span className="text-sm" style={{ color: "var(--muted)" }}>{cycle.completed}/{cycle.appraisals} completed</span>
        <form action={setCycleStatusAction} className="ml-auto flex items-center gap-2">
          <input type="hidden" name="cycleId" value={cycle.id} />
          <select name="status" defaultValue={cycle.status} className="select select-sm">{CYCLE_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
          <button className="btn btn-sm" type="submit">Set status</button>
        </form>
      </div>

      <SectionTitle>Appraisals ({appraisals.length})</SectionTitle>
      {appraisals.length === 0 ? (
        <Empty title="No appraisals in this cycle" hint="Add one for a staff member below." />
      ) : (
        <div className="card overflow-x-auto mt-2 mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Employee</th><th className="th text-left">Appraiser</th><th className="th text-right">Items</th><th className="th text-right">Overall</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {appraisals.map((a) => (
                <tr key={a.id}>
                  <td className="td"><div className="font-medium">{a.employeeName}</div>{a.jobTitle && <div className="text-xs" style={{ color: "var(--muted)" }}>{a.jobTitle}</div>}</td>
                  <td className="td">{a.appraiserName ?? "—"}</td>
                  <td className="td text-right tabular-nums">{a.items}</td>
                  <td className="td text-right">{a.overallRating != null ? <span title={ratingLabel(a.overallRating) ?? ""}>{a.overallRating}/5</span> : a.managerAvg != null ? <span style={{ color: "var(--muted)" }}>{a.managerAvg}/5*</span> : "—"}</td>
                  <td className="td"><StatusBadge status={a.status} /></td>
                  <td className="td text-right"><Link href={`/hr/appraisals/record/${a.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {remaining.length > 0 ? (
        <div className="card p-4">
          <SectionTitle>Add appraisal</SectionTitle>
          <form action={createAppraisalAction} className="grid sm:grid-cols-2 gap-3 mt-2">
            <input type="hidden" name="cycleId" value={cycle.id} />
            <Field label="Employee *"><select name="employeeId" required className="select"><option value="">Select…</option>{remaining.map((e) => <option key={e.id} value={e.id}>{e.name}{e.jobTitle ? ` — ${e.jobTitle}` : ""}</option>)}</select></Field>
            <Field label="Appraiser (manager)"><select name="appraiserEmployeeId" className="select"><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
            <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Start appraisal</button></div>
          </form>
        </div>
      ) : employees.length > 0 ? (
        <p className="text-sm" style={{ color: "var(--muted)" }}>Every active staff member has an appraisal in this cycle.</p>
      ) : (
        <p className="text-sm" style={{ color: "var(--muted)" }}>Add employees in <Link href="/hr/employees" className="hover:underline" style={{ color: "var(--brand)" }}>HR → Employees</Link> first.</p>
      )}
    </div>
  );
}
