import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { listEngagements, engagementStats, ENGAGEMENT_TYPES, ENGAGEMENT_STATUSES } from "@/server/services/auditreview";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Badge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { createAuditEngagementAction } from "@/app/actions";

export default async function AuditsPage({ searchParams }: { searchParams: Promise<{ status?: string; type?: string; search?: string; err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
  const [engagements, stats] = await Promise.all([
    listEngagements(orgId, { status: sp.status, type: sp.type, search: sp.search }),
    engagementStats(orgId),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Audit engagements" subtitle={`External, donor & internal audits and compliance reviews for ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.err === "title" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>An engagement title is required.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Active engagements" value={String(stats.active)} />
        <Stat label="Open findings" value={String(stats.openFindings)} tone={stats.openFindings ? "warn" : undefined} />
        <Stat label="High-risk open" value={String(stats.highOpen)} tone={stats.highOpen ? "danger" : undefined} />
        <Stat label="Overdue actions" value={String(stats.overdue)} tone={stats.overdue ? "danger" : undefined} />
      </div>

      <form className="card p-3 mb-4 flex flex-wrap gap-3 items-end">
        <Field label="Type"><select name="type" defaultValue={sp.type ?? ""} className="select select-sm"><option value="">All</option>{ENGAGEMENT_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select select-sm"><option value="">All</option>{ENGAGEMENT_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <Field label="Search"><input name="search" defaultValue={sp.search ?? ""} className="input input-sm" placeholder="Title or auditor" /></Field>
        <button className="btn btn-sm btn-primary" type="submit">Apply</button>
        <Link href="/finance/audits" className="btn btn-sm">Reset</Link>
      </form>

      <SectionTitle>Engagements</SectionTitle>
      <div className="mt-2 mb-6">
        {engagements.length === 0 ? <Empty title="No engagements" hint="Record an audit or compliance review below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Engagement</th><th className="th text-left">Type</th><th className="th text-left">FY</th><th className="th text-left">Findings</th><th className="th text-left">Report date</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>
                {engagements.map((e) => (
                  <tr key={e.id}>
                    <td className="td"><div className="font-medium">{e.title}</div>{e.auditor && <div className="text-xs" style={{ color: "var(--muted)" }}>{e.auditor}</div>}</td>
                    <td className="td">{label(e.type)}</td>
                    <td className="td">{e.fiscalYear ?? "—"}</td>
                    <td className="td">
                      {e.findings === 0 ? <span style={{ color: "var(--muted)" }}>—</span> : (
                        <span className="flex items-center gap-1">
                          <span>{e.findings}</span>
                          {e.open > 0 && <Badge tone="warn">{e.open} open</Badge>}
                          {e.highOpen > 0 && <Badge tone="danger">{e.highOpen} high</Badge>}
                          {e.overdue > 0 && <Badge tone="danger">{e.overdue} overdue</Badge>}
                        </span>
                      )}
                    </td>
                    <td className="td whitespace-nowrap">{e.reportDate ? fmtDate(e.reportDate) : "—"}</td>
                    <td className="td"><StatusBadge status={e.status} /></td>
                    <td className="td text-right"><Link href={`/finance/audits/${e.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card p-4">
        <SectionTitle>New engagement</SectionTitle>
        <form action={createAuditEngagementAction} className="grid sm:grid-cols-2 gap-3 mt-2">
          <div className="sm:col-span-2"><Field label="Title *"><input name="title" required className="input" placeholder="e.g. FY2025 Statutory Audit — KPMG" /></Field></div>
          <Field label="Type"><select name="type" className="select">{ENGAGEMENT_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Auditor / firm"><input name="auditor" className="input" /></Field>
          <Field label="Fiscal year"><input name="fiscalYear" className="input" placeholder="2025" /></Field>
          <Field label="Status"><select name="status" className="select">{ENGAGEMENT_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
          <Field label="Period from"><input name="periodStart" type="date" className="input" /></Field>
          <Field label="Period to"><input name="periodEnd" type="date" className="input" /></Field>
          <Field label="Fieldwork start"><input name="startDate" type="date" defaultValue={today} className="input" /></Field>
          <Field label="Report date"><input name="reportDate" type="date" className="input" /></Field>
          <Field label="Lead contact"><input name="leadContact" className="input" /></Field>
          <Field label="Overall opinion / rating"><input name="opinion" className="input" placeholder="e.g. Unqualified" /></Field>
          <div className="sm:col-span-2"><Field label="Scope"><input name="scope" className="input" /></Field></div>
          <div className="sm:col-span-2"><Field label="Audit report document"><input name="file" type="file" className="input" /></Field></div>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Create engagement</button></div>
        </form>
      </div>
    </div>
  );
}
