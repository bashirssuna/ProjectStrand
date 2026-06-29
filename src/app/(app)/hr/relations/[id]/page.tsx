import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHrOrg } from "../../_guard";
import { getCase, listEvents, STAGES, OUTCOMES, EVENT_KINDS, CLOSED_STAGES } from "@/server/services/er";
import { PageHeader, SectionTitle, Field, StatusBadge, Badge, Empty } from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { setCaseStatusAction, recordCaseOutcomeAction, addCaseEventAction } from "@/app/actions";

const sevTone = (s: string) => (s === "high" ? "danger" : s === "medium" ? "warn" : "muted");

export default async function CaseDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const { id } = await params;
  const sp = await searchParams;
  const k = await getCase(orgId, id);
  if (!k) notFound();
  const events = await listEvents(orgId, id);
  const stages = STAGES[k.type] ?? STAGES.grievance;
  const outcomes = OUTCOMES[k.type] ?? OUTCOMES.grievance;
  const closed = CLOSED_STAGES.includes(k.status);
  const subjectLabel = k.type === "grievance" ? "Complainant" : "Respondent";
  const otherLabel = k.type === "grievance" ? "Respondent / against" : "Reported by";

  return (
    <div className="max-w-4xl">
      <PageHeader title={k.title} subtitle={`${label(k.type)} · ${k.caseNo ?? ""} · ${orgName}`} actions={<Link href="/hr/relations" className="btn btn-sm">← Cases</Link>} />
      {sp.err === "event" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A summary is required for the entry.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={k.status} />
        <Badge tone={sevTone(k.severity)}>{label(k.severity)} severity</Badge>
        {k.confidential && <Badge tone="danger">Confidential</Badge>}
        {k.outcome && <Badge tone="ok">Outcome: {label(k.outcome)}</Badge>}
        {!closed && (
          <form action={setCaseStatusAction} className="ml-auto flex items-center gap-2">
            <input type="hidden" name="caseId" value={k.id} />
            <select name="status" defaultValue={k.status} className="select select-sm">{stages.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
            <button className="btn btn-sm" type="submit">Set stage</button>
          </form>
        )}
      </div>

      <div className="card p-4 mb-5 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <div><span className="label">{subjectLabel}</span> {k.employeeName ?? "—"}</div>
        <div><span className="label">{otherLabel}</span> {k.counterparty ?? "—"}</div>
        {k.category && <div><span className="label">Category</span> {k.category}</div>}
        {k.assignedTo && <div><span className="label">Handler</span> {k.assignedTo}</div>}
        {k.openedDate && <div><span className="label">Opened</span> {fmtDate(k.openedDate)}</div>}
        {k.dueDate && <div><span className="label">Target resolution</span> {fmtDate(k.dueDate)}</div>}
        {k.closedDate && <div><span className="label">Closed</span> {fmtDate(k.closedDate)}</div>}
        {k.createdByName && <div><span className="label">Logged by</span> {k.createdByName}</div>}
        {k.description && <div className="sm:col-span-2"><span className="label">Description</span><p className="whitespace-pre-wrap">{k.description}</p></div>}
        {k.outcomeNotes && <div className="sm:col-span-2"><span className="label">Outcome notes</span><p className="whitespace-pre-wrap">{k.outcomeNotes}</p></div>}
      </div>

      {/* Timeline */}
      <SectionTitle>Case timeline</SectionTitle>
      <div className="mt-2 mb-4">
        {events.length === 0 ? <Empty title="No activity yet" hint="Log investigation steps, hearings, notices and decisions below." /> : (
          <div className="space-y-2">
            {events.map((ev) => (
              <div key={ev.id} className="card p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge tone={ev.kind === "decision" ? "ok" : ev.kind === "status_change" ? "muted" : "info"}>{label(ev.kind)}</Badge>
                  <span className="text-sm font-medium">{ev.summary}</span>
                  <span className="text-xs ml-auto" style={{ color: "var(--muted)" }}>{ev.eventDate ? fmtDate(ev.eventDate) : fmtDateTime(ev.createdAt)}{ev.author ? ` · ${ev.author}` : ""}</span>
                </div>
                {ev.detail && <p className="text-sm mt-1 whitespace-pre-wrap" style={{ color: "var(--muted)" }}>{ev.detail}</p>}
                {ev.fileKey && <a href={`/api/case-files/${ev.id}`} className="text-xs hover:underline" style={{ color: "var(--brand)" }}>📎 {ev.fileName ?? "attachment"}</a>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add entry */}
      <details className="card p-4 mb-5">
        <summary className="text-sm font-medium cursor-pointer">+ Add timeline entry</summary>
        <form action={addCaseEventAction} className="grid sm:grid-cols-2 gap-2 mt-3">
          <input type="hidden" name="caseId" value={k.id} />
          <Field label="Type"><select name="kind" defaultValue="note" className="select select-sm">{EVENT_KINDS.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          <Field label="Date"><input name="eventDate" type="date" className="input input-sm" /></Field>
          <div className="sm:col-span-2"><Field label="Summary *"><input name="summary" required className="input input-sm" placeholder="e.g. Investigation meeting held with witnesses" /></Field></div>
          <div className="sm:col-span-2"><Field label="Detail"><textarea name="detail" rows={2} className="input" /></Field></div>
          <Field label="Attachment (evidence / notice / minutes)"><input name="file" type="file" className="input input-sm" /></Field>
          <Field label="Logged by"><input name="author" className="input input-sm" placeholder="Defaults to you" /></Field>
          <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Add entry</button></div>
        </form>
      </details>

      {/* Outcome */}
      {!closed ? (
        <>
          <SectionTitle>Record outcome &amp; close</SectionTitle>
          <form action={recordCaseOutcomeAction} className="card p-4 mt-2 grid sm:grid-cols-2 gap-3">
            <input type="hidden" name="caseId" value={k.id} />
            <Field label={k.type === "grievance" ? "Grievance outcome" : "Disciplinary outcome / sanction"}><select name="outcome" required className="select"><option value="">Select…</option>{outcomes.map((o) => <option key={o} value={o}>{label(o)}</option>)}</select></Field>
            <div />
            <div className="sm:col-span-2"><Field label="Outcome notes / rationale"><textarea name="outcomeNotes" rows={3} className="input" /></Field></div>
            <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Record outcome & close case</button></div>
          </form>
        </>
      ) : (
        <div className="card p-4 text-sm" style={{ color: "var(--muted)" }}>
          Case closed{k.outcome ? ` — outcome: ${label(k.outcome)}` : ""}{k.closedDate ? ` on ${fmtDate(k.closedDate)}` : ""}.
        </div>
      )}
    </div>
  );
}
