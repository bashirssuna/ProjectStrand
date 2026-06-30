import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFinanceOrg } from "../../_guard";
import { getEngagement, listFindings, ENGAGEMENT_STATUSES, FINDING_AREAS, FINDING_RISKS } from "@/server/services/auditreview";
import { PageHeader, SectionTitle, Field, Stat, Badge, StatusBadge, Empty, ProgressBar } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { setAuditEngagementStatusAction, updateAuditEngagementAction, deleteAuditEngagementAction, addAuditFindingAction } from "@/app/actions";

const riskTone = (r: string) => (r === "high" ? "danger" : r === "low" ? "muted" : "warn");

export default async function EngagementDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const { id } = await params;
  const sp = await searchParams;
  const e = await getEngagement(orgId, id);
  if (!e) notFound();
  const findings = await listFindings(orgId, id);
  const today = new Date().toISOString().slice(0, 10);
  const pct = e.total > 0 ? Math.round((e.implemented / e.total) * 100) : 0;
  const dStr = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

  return (
    <div className="max-w-5xl">
      <PageHeader title={e.title} subtitle={`${label(e.type)} · ${orgName}`} actions={<><a href={`/print/audit-engagement/${e.id}`} target="_blank" className="btn btn-sm">Print report ↗</a><Link href="/finance/audits" className="btn btn-sm">← Engagements</Link></>} />
      {sp.err === "ftitle" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A finding title is required.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={e.status} />
        {e.fiscalYear && <Badge tone="info">FY {e.fiscalYear}</Badge>}
        {e.opinion && <span className="text-sm"><span style={{ color: "var(--muted)" }}>Opinion:</span> {e.opinion}</span>}
        <div className="ml-auto flex items-center gap-2">
          <form action={setAuditEngagementStatusAction} className="flex items-center gap-2">
            <input type="hidden" name="engagementId" value={e.id} />
            <select name="status" defaultValue={e.status} className="select select-sm">{ENGAGEMENT_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
            <button className="btn btn-sm" type="submit">Set status</button>
          </form>
          <form action={deleteAuditEngagementAction}><input type="hidden" name="engagementId" value={e.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Findings" value={String(e.total)} />
        <Stat label="Resolved" value={`${e.implemented}/${e.total}`} tone={e.total > 0 && e.implemented === e.total ? "ok" : undefined} />
        <Stat label="Report date" value={e.reportDate ? fmtDate(e.reportDate) : "—"} />
        <Stat label="Auditor" value={e.auditor ?? "—"} />
      </div>
      {e.total > 0 && <div className="card p-3 mb-5"><div className="flex justify-between text-xs mb-1"><span style={{ color: "var(--muted)" }}>Remediation progress</span><span>{pct}%</span></div><ProgressBar value={pct} /></div>}

      <div className="card p-4 mb-5 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {(e.periodStart || e.periodEnd) && <div><span className="label">Period covered</span> {e.periodStart ? fmtDate(e.periodStart) : "—"} – {e.periodEnd ? fmtDate(e.periodEnd) : "—"}</div>}
        {(e.startDate || e.endDate) && <div><span className="label">Fieldwork</span> {e.startDate ? fmtDate(e.startDate) : "—"} – {e.endDate ? fmtDate(e.endDate) : "—"}</div>}
        {e.leadContact && <div><span className="label">Lead contact</span> {e.leadContact}</div>}
        {e.scope && <div className="sm:col-span-2"><span className="label">Scope</span> {e.scope}</div>}
        {e.notes && <div className="sm:col-span-2"><span className="label">Notes</span> <span className="whitespace-pre-wrap">{e.notes}</span></div>}
        {e.fileKey && <div className="sm:col-span-2"><a href={`/api/audit-files/engagement/${e.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>📎 {e.fileName ?? "Audit report"}</a></div>}
      </div>

      {/* Findings */}
      <SectionTitle>Findings &amp; recommendations</SectionTitle>
      <div className="mt-2 mb-4">
        {findings.length === 0 ? <Empty title="No findings" hint="Add findings raised in this engagement below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Ref</th><th className="th text-left">Finding</th><th className="th text-left">Area</th><th className="th text-left">Risk</th><th className="th text-left">Responsible</th><th className="th text-left">Target</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>
                {findings.map((x) => (
                  <tr key={x.id}>
                    <td className="td font-mono text-xs">{x.ref}</td>
                    <td className="td font-medium">{x.title}</td>
                    <td className="td">{x.area ?? "—"}</td>
                    <td className="td"><Badge tone={riskTone(x.risk)}>{label(x.risk)}</Badge></td>
                    <td className="td">{x.responsible ?? "—"}</td>
                    <td className="td whitespace-nowrap">{x.targetDate ? <span style={{ color: x.overdue ? "var(--danger)" : undefined }}>{fmtDate(x.targetDate)}{x.overdue ? " ⚠" : ""}</span> : "—"}</td>
                    <td className="td"><StatusBadge status={x.status} /></td>
                    <td className="td text-right"><Link href={`/finance/audits/finding/${x.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <div className="card p-4">
          <SectionTitle>Add finding</SectionTitle>
          <form action={addAuditFindingAction} className="grid sm:grid-cols-2 gap-3 mt-2">
            <input type="hidden" name="engagementId" value={e.id} />
            <div className="sm:col-span-2"><Field label="Title *"><input name="title" required className="input input-sm" /></Field></div>
            <Field label="Area"><select name="area" className="select select-sm"><option value="">—</option>{FINDING_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}</select></Field>
            <Field label="Risk"><select name="risk" defaultValue="medium" className="select select-sm">{FINDING_RISKS.map((r) => <option key={r} value={r}>{label(r)}</option>)}</select></Field>
            <div className="sm:col-span-2"><Field label="Observation"><textarea name="observation" rows={2} className="input input-sm" /></Field></div>
            <div className="sm:col-span-2"><Field label="Recommendation"><textarea name="recommendation" rows={2} className="input input-sm" /></Field></div>
            <Field label="Responsible"><input name="responsible" className="input input-sm" /></Field>
            <Field label="Target date"><input name="targetDate" type="date" className="input input-sm" /></Field>
            <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Add finding</button></div>
          </form>
        </div>

        <details className="card p-4 self-start">
          <summary className="text-sm font-medium cursor-pointer">Edit engagement details</summary>
          <form action={updateAuditEngagementAction} className="grid sm:grid-cols-2 gap-3 mt-3">
            <input type="hidden" name="engagementId" value={e.id} />
            <Field label="Auditor"><input name="auditor" defaultValue={e.auditor ?? ""} className="input input-sm" /></Field>
            <Field label="Fiscal year"><input name="fiscalYear" defaultValue={e.fiscalYear ?? ""} className="input input-sm" /></Field>
            <Field label="Period from"><input name="periodStart" type="date" defaultValue={dStr(e.periodStart)} className="input input-sm" /></Field>
            <Field label="Period to"><input name="periodEnd" type="date" defaultValue={dStr(e.periodEnd)} className="input input-sm" /></Field>
            <Field label="Fieldwork start"><input name="startDate" type="date" defaultValue={dStr(e.startDate)} className="input input-sm" /></Field>
            <Field label="Fieldwork end"><input name="endDate" type="date" defaultValue={dStr(e.endDate)} className="input input-sm" /></Field>
            <Field label="Report date"><input name="reportDate" type="date" defaultValue={dStr(e.reportDate)} className="input input-sm" /></Field>
            <Field label="Opinion"><input name="opinion" defaultValue={e.opinion ?? ""} className="input input-sm" /></Field>
            <Field label="Lead contact"><input name="leadContact" defaultValue={e.leadContact ?? ""} className="input input-sm" /></Field>
            <div className="sm:col-span-2"><Field label="Scope"><input name="scope" defaultValue={e.scope ?? ""} className="input input-sm" /></Field></div>
            <div className="sm:col-span-2"><Field label="Notes"><textarea name="notes" rows={2} defaultValue={e.notes ?? ""} className="input input-sm" /></Field></div>
            <div className="sm:col-span-2"><Field label="Replace audit report document"><input name="file" type="file" className="input input-sm" /></Field></div>
            <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Save details</button></div>
          </form>
        </details>
      </div>
    </div>
  );
}
