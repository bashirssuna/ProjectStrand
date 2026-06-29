import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFinanceOrg } from "../../../_guard";
import { getFinding, listFindingUpdates, FINDING_STATUSES } from "@/server/services/auditreview";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { updateAuditFindingResponseAction, setAuditFindingStatusAction, deleteAuditFindingAction, addAuditFindingUpdateAction } from "@/app/actions";

const riskTone = (r: string) => (r === "high" ? "danger" : r === "low" ? "muted" : "warn");

export default async function FindingDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const { id } = await params;
  const sp = await searchParams;
  const x = await getFinding(orgId, id);
  if (!x) notFound();
  const updates = await listFindingUpdates(orgId, id);
  const today = new Date().toISOString().slice(0, 10);
  const dStr = (d: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");

  return (
    <div className="max-w-4xl">
      <PageHeader title={`${x.ref ? x.ref + " · " : ""}${x.title}`} subtitle={`Finding · ${x.engagementTitle}`} actions={<Link href={`/finance/audits/${x.engagementId}`} className="btn btn-sm">← Engagement</Link>} />
      {sp.err === "note" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Add a note or select a status.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={x.status} />
        <Badge tone={riskTone(x.risk)}>{label(x.risk)} risk</Badge>
        {x.area && <Badge tone="info">{x.area}</Badge>}
        {x.overdue && <Badge tone="danger">Overdue</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <form action={setAuditFindingStatusAction} className="flex items-center gap-2">
            <input type="hidden" name="findingId" value={x.id} />
            <select name="status" defaultValue={x.status} className="select select-sm">{FINDING_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
            <button className="btn btn-sm" type="submit">Set status</button>
          </form>
          <form action={deleteAuditFindingAction}><input type="hidden" name="findingId" value={x.id} /><input type="hidden" name="engagementId" value={x.engagementId} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      <div className="card p-4 mb-5 space-y-3 text-sm">
        {x.observation && <div><div className="label">Observation</div><p className="whitespace-pre-wrap mt-1">{x.observation}</p></div>}
        {x.recommendation && <div><div className="label">Recommendation</div><p className="whitespace-pre-wrap mt-1">{x.recommendation}</p></div>}
        {!x.observation && !x.recommendation && <p style={{ color: "var(--muted)" }}>No observation or recommendation recorded.</p>}
      </div>

      <div className="grid md:grid-cols-2 gap-5 mb-5">
        <div className="card p-4">
          <SectionTitle>Management response &amp; action plan</SectionTitle>
          <form action={updateAuditFindingResponseAction} className="grid gap-3 mt-2">
            <input type="hidden" name="findingId" value={x.id} />
            <Field label="Management response"><textarea name="mgmtResponse" rows={3} defaultValue={x.mgmtResponse ?? ""} className="input input-sm" /></Field>
            <Field label="Agreed action"><textarea name="agreedAction" rows={2} defaultValue={x.agreedAction ?? ""} className="input input-sm" /></Field>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Responsible"><input name="responsible" defaultValue={x.responsible ?? ""} className="input input-sm" /></Field>
              <Field label="Target date"><input name="targetDate" type="date" defaultValue={dStr(x.targetDate)} className="input input-sm" /></Field>
            </div>
            <div><button className="btn btn-sm btn-primary" type="submit">Save response</button></div>
          </form>
        </div>

        <div className="card p-4 self-start">
          <SectionTitle>Log remediation update</SectionTitle>
          <form action={addAuditFindingUpdateAction} className="grid gap-3 mt-2">
            <input type="hidden" name="findingId" value={x.id} />
            <Field label="Progress note"><textarea name="note" rows={3} className="input input-sm" placeholder="What was done toward closing this finding?" /></Field>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Date"><input name="updateDate" type="date" defaultValue={today} className="input input-sm" /></Field>
              <Field label="Set status (optional)"><select name="statusAt" className="select select-sm"><option value="">No change</option>{FINDING_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
            </div>
            <Field label="Evidence (optional)"><input name="file" type="file" className="input input-sm" /></Field>
            <div><button className="btn btn-sm btn-primary" type="submit">Add update</button></div>
          </form>
        </div>
      </div>

      <SectionTitle>Remediation trail</SectionTitle>
      <div className="mt-2">
        {updates.length === 0 ? <Empty title="No updates yet" hint="Log progress toward implementing this recommendation above." /> : (
          <div className="space-y-2">
            {updates.map((u) => (
              <div key={u.id} className="card p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium">{fmtDate(u.updateDate)}</span>
                  {u.statusAt && <Badge tone="info">→ {label(u.statusAt)}</Badge>}
                  {u.author && <span className="text-xs ml-auto" style={{ color: "var(--muted)" }}>{u.author}</span>}
                </div>
                {u.note && <p className="text-sm mt-1 whitespace-pre-wrap">{u.note}</p>}
                {u.fileKey && <a href={`/api/audit-files/update/${u.id}`} className="text-xs hover:underline" style={{ color: "var(--brand)" }}>📎 {u.fileName ?? "evidence"}</a>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
