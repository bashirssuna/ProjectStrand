import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { q } from "@/server/db";
import { listCases, caseStats } from "@/server/services/er";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Badge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { createCaseAction } from "@/app/actions";

const SEVERITY = ["low", "medium", "high"];
const sevTone = (s: string) => (s === "high" ? "danger" : s === "medium" ? "warn" : "muted");

export default async function RelationsPage({ searchParams }: { searchParams: Promise<{ type?: string; status?: string; search?: string; err?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const sp = await searchParams;
  const [cases, stats, employees] = await Promise.all([
    listCases(orgId, { type: sp.type, status: sp.status, search: sp.search }),
    caseStats(orgId),
    q<{ id: string; name: string }>(`SELECT id, (first_name || ' ' || last_name) AS name FROM employee WHERE org_id=$1 AND status != 'terminated' ORDER BY first_name, last_name`, [orgId]),
  ]);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Employee relations" subtitle={`Grievances & disciplinary cases for ${orgName}`} actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.err === "title" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A case title is required.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Open grievances" value={String(stats.grievanceOpen)} tone={stats.grievanceOpen ? "warn" : undefined} />
        <Stat label="Open disciplinary" value={String(stats.disciplinaryOpen)} tone={stats.disciplinaryOpen ? "warn" : undefined} />
        <Stat label="Overdue" value={String(stats.overdue)} tone={stats.overdue ? "danger" : undefined} />
        <Stat label="Closed" value={String(stats.closed)} />
      </div>

      <form className="card p-4 mb-5 grid sm:grid-cols-4 gap-3 items-end">
        <Field label="Type"><select name="type" defaultValue={sp.type ?? ""} className="select"><option value="">All</option><option value="grievance">Grievance</option><option value="disciplinary">Disciplinary</option></select></Field>
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select"><option value="">All</option><option value="open">Open</option><option value="closed">Closed</option></select></Field>
        <Field label="Search"><input name="search" defaultValue={sp.search ?? ""} className="input" placeholder="Title or case no." /></Field>
        <div className="flex gap-2"><button className="btn btn-primary" type="submit">Apply</button><Link href="/hr/relations" className="btn">Reset</Link></div>
      </form>

      {cases.length === 0 ? (
        <Empty title="No cases" hint="Log a grievance or disciplinary case below." />
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Case</th><th className="th text-left">Type</th><th className="th text-left">Concerns</th><th className="th text-left">Severity</th><th className="th text-left">Due</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {cases.map((c) => (
                <tr key={c.id}>
                  <td className="td"><div className="font-medium">{c.title}</div><div className="text-xs font-mono" style={{ color: "var(--muted)" }}>{c.caseNo}{c.confidential ? " · confidential" : ""}</div></td>
                  <td className="td">{label(c.type)}</td>
                  <td className="td">{c.employeeName ?? c.counterparty ?? "—"}</td>
                  <td className="td"><Badge tone={sevTone(c.severity)}>{label(c.severity)}</Badge></td>
                  <td className="td whitespace-nowrap">{c.dueDate ? fmtDate(c.dueDate) : "—"}</td>
                  <td className="td"><StatusBadge status={c.status} /></td>
                  <td className="td text-right"><Link href={`/hr/relations/${c.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-4">
        <SectionTitle>Log a case</SectionTitle>
        <form action={createCaseAction} className="grid sm:grid-cols-2 gap-3 mt-2">
          <Field label="Type *"><select name="type" required className="select"><option value="grievance">Grievance (raised by an employee)</option><option value="disciplinary">Disciplinary (against an employee)</option></select></Field>
          <Field label="Severity"><select name="severity" defaultValue="medium" className="select">{SEVERITY.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
          <Field label="Employee concerned"><select name="employeeId" className="select"><option value="">—</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
          <Field label="Other party (respondent / reporter)"><input name="counterparty" className="input" placeholder="Name" /></Field>
          <Field label="Category"><input name="category" className="input" placeholder="e.g. harassment, attendance, policy breach" /></Field>
          <Field label="Assigned to (handler)"><input name="assignedTo" className="input" /></Field>
          <Field label="Title *"><input name="title" required className="input" placeholder="Short summary of the case" /></Field>
          <Field label="Target resolution date"><input name="dueDate" type="date" className="input" /></Field>
          <div className="sm:col-span-2"><Field label="Description"><textarea name="description" rows={3} className="input" placeholder="What happened" /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="confidential" /> Mark confidential</label>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Open case</button></div>
        </form>
      </div>
    </div>
  );
}
