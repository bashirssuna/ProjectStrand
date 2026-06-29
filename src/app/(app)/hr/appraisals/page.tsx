import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { listCycles, orgAppraisalStats } from "@/server/services/appraisals";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Empty, ProgressBar } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { createCycleAction } from "@/app/actions";

const KINDS = ["annual", "mid_year", "probation", "quarterly"];

export default async function AppraisalsPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const sp = await searchParams;
  const [cycles, stats] = await Promise.all([listCycles(orgId), orgAppraisalStats(orgId)]);

  return (
    <div className="max-w-4xl">
      <PageHeader title="Performance appraisals" subtitle={`Review cycles & staff appraisals for ${orgName}`} actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.err === "name" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A cycle name is required.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Cycles" value={String(stats.cycles)} sub={`${stats.openCycles} open`} />
        <Stat label="In progress" value={String(stats.inProgress)} tone={stats.inProgress ? "warn" : undefined} />
        <Stat label="Completed" value={String(stats.completed)} />
        <Stat label="Avg rating" value={stats.avgRating != null ? `${stats.avgRating}/5` : "—"} />
      </div>

      {cycles.length === 0 ? (
        <Empty title="No review cycles yet" hint="Create a cycle below, then add an appraisal for each staff member." />
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Cycle</th><th className="th text-left">Type</th><th className="th text-left">Period</th><th className="th text-left">Due</th><th className="th text-left w-40">Progress</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {cycles.map((c) => (
                <tr key={c.id}>
                  <td className="td font-medium">{c.name}</td>
                  <td className="td">{label(c.kind)}</td>
                  <td className="td whitespace-nowrap">{c.periodStart ? fmtDate(c.periodStart) : "—"}{c.periodEnd ? ` – ${fmtDate(c.periodEnd)}` : ""}</td>
                  <td className="td whitespace-nowrap">{c.dueDate ? fmtDate(c.dueDate) : "—"}</td>
                  <td className="td">{c.appraisals > 0 ? <div className="flex items-center gap-2"><ProgressBar value={Math.round((c.completed / c.appraisals) * 100)} /><span className="text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>{c.completed}/{c.appraisals}</span></div> : <span className="text-xs" style={{ color: "var(--muted)" }}>—</span>}</td>
                  <td className="td"><StatusBadge status={c.status} /></td>
                  <td className="td text-right"><Link href={`/hr/appraisals/${c.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-4">
        <SectionTitle>New review cycle</SectionTitle>
        <form action={createCycleAction} className="grid sm:grid-cols-2 gap-3 mt-2">
          <Field label="Cycle name *"><input name="name" required className="input" placeholder="e.g. 2026 Annual Performance Review" /></Field>
          <Field label="Type"><select name="kind" defaultValue="annual" className="select">{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
          <Field label="Period start"><input name="periodStart" type="date" className="input" /></Field>
          <Field label="Period end"><input name="periodEnd" type="date" className="input" /></Field>
          <Field label="Due date"><input name="dueDate" type="date" className="input" /></Field>
          <Field label="Rating scale (max)"><input name="ratingMax" type="number" min="3" max="10" defaultValue="5" className="input" /></Field>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Create cycle</button></div>
        </form>
      </div>
    </div>
  );
}
