import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFinanceOrg } from "../../_guard";
import { getReport, listMessages, WB_STATUSES, WB_SEVERITIES, WB_OUTCOMES, WB_CLOSED } from "@/server/services/whistleblower";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty } from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { setWhistleblowerStatusAction, triageWhistleblowerAction, recordWhistleblowerOutcomeAction, addReviewerMessageAction, deleteWhistleblowerReportAction } from "@/app/actions";

const sevTone = (s: string) => (s === "critical" ? "danger" : s === "high" ? "warn" : s === "low" ? "muted" : "info");

export default async function WhistleblowerDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const { id } = await params;
  const sp = await searchParams;
  const r = await getReport(orgId, id);
  if (!r) notFound();
  const messages = await listMessages(r.id, { includeInternal: true });
  const closed = WB_CLOSED.includes(r.status);

  return (
    <div className="max-w-4xl">
      <PageHeader title={r.title} subtitle={`Confidential report · ${orgName}`} actions={<Link href="/finance/whistleblower" className="btn btn-sm">← Reports</Link>} />
      {sp.err === "body" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A message is required.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={r.status} />
        <Badge tone={sevTone(r.severity)}>{label(r.severity)}</Badge>
        <span className="text-xs font-mono" style={{ color: "var(--muted)" }}>{r.trackingCode}</span>
        {r.isAnonymous ? <Badge tone="muted">Anonymous</Badge> : <Badge tone="info">Identified</Badge>}
        {r.retaliationConcern && <Badge tone="danger">Retaliation concern</Badge>}
        <div className="ml-auto flex items-center gap-2">
          {!closed && (
            <form action={setWhistleblowerStatusAction} className="flex items-center gap-2">
              <input type="hidden" name="reportId" value={r.id} />
              <select name="status" defaultValue={r.status} className="select select-sm">{WB_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
              <button className="btn btn-sm" type="submit">Set stage</button>
            </form>
          )}
          <form action={deleteWhistleblowerReportAction}><input type="hidden" name="reportId" value={r.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      <div className="card p-4 mb-5 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {r.category && <div><span className="label">Category</span> {r.category}</div>}
        <div><span className="label">Received</span> {fmtDate(r.createdAt)}</div>
        {r.incidentDate && <div><span className="label">Incident date</span> {fmtDate(r.incidentDate)}</div>}
        {r.location && <div><span className="label">Location</span> {r.location}</div>}
        {r.personsInvolved && <div className="sm:col-span-2"><span className="label">Persons involved</span> {r.personsInvolved}</div>}
        {!r.isAnonymous && (r.reporterName || r.reporterContact) && <div className="sm:col-span-2"><span className="label">Reporter</span> {[r.reporterName, r.reporterContact].filter(Boolean).join(" · ")}</div>}
        {r.description && <div className="sm:col-span-2"><span className="label">Description</span><p className="whitespace-pre-wrap">{r.description}</p></div>}
        {closed && r.outcome && <div className="sm:col-span-2"><span className="label">Outcome</span> {label(r.outcome)}{r.outcomeNotes ? <p className="whitespace-pre-wrap">{r.outcomeNotes}</p> : null}</div>}
      </div>

      {/* Triage */}
      {!closed && (
        <details className="card p-4 mb-5">
          <summary className="text-sm font-medium cursor-pointer">Triage (assign handler & severity)</summary>
          <form action={triageWhistleblowerAction} className="grid sm:grid-cols-2 gap-3 mt-3">
            <input type="hidden" name="reportId" value={r.id} />
            <Field label="Handler / officer"><input name="handler" defaultValue={r.handler ?? ""} className="input input-sm" /></Field>
            <Field label="Severity"><select name="severity" defaultValue={r.severity} className="select select-sm">{WB_SEVERITIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
            <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Save triage</button></div>
          </form>
        </details>
      )}

      {/* Thread */}
      <SectionTitle>Correspondence &amp; notes</SectionTitle>
      <div className="mt-2 mb-4">
        {messages.length === 0 ? <Empty title="No correspondence" hint="Respond to the reporter or add internal notes below." /> : (
          <div className="space-y-2">
            {messages.map((m) => (
              <div key={m.id} className="card p-3" style={{ borderLeft: `3px solid ${m.internal ? "var(--warn)" : m.sender === "reviewer" ? "var(--brand)" : "var(--muted)"}` }}>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs font-medium">{m.sender === "reviewer" ? (m.authorName ?? "Reviewer") : "Reporter"}</span>
                  {m.internal && <Badge tone="warn">Internal note</Badge>}
                  {m.sender === "reviewer" && !m.internal && <Badge tone="info">Visible to reporter</Badge>}
                  <span className="text-xs ml-auto" style={{ color: "var(--muted)" }}>{fmtDateTime(m.createdAt)}</span>
                </div>
                {m.body && <p className="text-sm mt-1 whitespace-pre-wrap">{m.body}</p>}
                {m.fileKey && <a href={`/api/whistleblower-files/${m.id}`} className="text-xs hover:underline" style={{ color: "var(--brand)" }}>📎 {m.fileName ?? "attachment"}</a>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-5">
        <div className="card p-4">
          <SectionTitle>Add message</SectionTitle>
          <form action={addReviewerMessageAction} className="grid gap-2 mt-2">
            <input type="hidden" name="reportId" value={r.id} />
            <textarea name="body" rows={3} required className="input input-sm" placeholder="Write a response or an internal note" />
            <Field label="Attachment"><input name="file" type="file" className="input input-sm" /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="internal" /> Internal note (not visible to the reporter)</label>
            <div><button className="btn btn-sm btn-primary" type="submit">Add</button></div>
          </form>
        </div>

        {!closed && (
          <div className="card p-4">
            <SectionTitle>Record outcome &amp; close</SectionTitle>
            <form action={recordWhistleblowerOutcomeAction} className="grid gap-2 mt-2">
              <input type="hidden" name="reportId" value={r.id} />
              <Field label="Outcome"><select name="outcome" required className="select select-sm"><option value="">Select…</option>{WB_OUTCOMES.map((o) => <option key={o} value={o}>{label(o)}</option>)}</select></Field>
              <Field label="Outcome notes / rationale"><textarea name="outcomeNotes" rows={3} className="input input-sm" /></Field>
              <div><button className="btn btn-sm btn-primary" type="submit">Record outcome & close</button></div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
