import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireLabOrg } from "../../_guard";
import { accessibleProjectIds, getParticipantForView, participantVisits, participantSamples, canSeePII, maskName, calcAge, formatAge } from "@/server/services/lab";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Stat, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { addParticipantVisitAction, updateParticipantVisitAction, deleteParticipantVisitAction, updateParticipantAction, updateParticipantConsentAction } from "@/app/actions";

type PSample = { id: string; sampleCode: string; visitId: string | null; typeName: string | null; status: string; collectionDate: string; freezerName: string | null; testCount: number };
const CONSENT = ["valid", "expired", "withdrawn"];
const consentTone = (s: string) => (s === "valid" ? "ok" : s === "expired" ? "warn" : "danger") as "ok" | "warn" | "danger";

function SampleTable({ samples }: { samples: PSample[] }) {
  if (samples.length === 0) return <p className="text-xs px-1 py-2" style={{ color: "var(--muted)" }}>No samples.</p>;
  return (
    <div className="overflow-x-auto"><table className="w-full text-sm">
      <thead><tr><th className="th text-left">Sample</th><th className="th text-left">Type</th><th className="th text-left">Collected</th><th className="th text-left">Freezer</th><th className="th text-right">Tests</th><th className="th text-left">Status</th></tr></thead>
      <tbody>{samples.map((s) => (
        <tr key={s.id}>
          <td className="td"><Link href={`/lab/samples/${s.id}`} className="font-mono text-xs hover:underline" style={{ color: "var(--brand)" }}>{s.sampleCode}</Link></td>
          <td className="td">{s.typeName ?? "—"}</td>
          <td className="td whitespace-nowrap">{fmtDate(s.collectionDate)}</td>
          <td className="td">{s.freezerName ?? "—"}</td>
          <td className="td text-right tabular-nums">{s.testCount || "—"}</td>
          <td className="td"><StatusBadge status={s.status} /></td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

export default async function ParticipantDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const seePII = canSeePII(isOrgAdmin, isSuperAdmin);
  const sp = await searchParams;
  const projectIds = await accessibleProjectIds(userId, orgId, isAdmin);

  const p = await getParticipantForView(orgId, id, projectIds, isAdmin);
  if (!p) notFound();
  const [visits, samples] = await Promise.all([participantVisits(id), participantSamples(id, projectIds)]);

  const revealed = seePII && sp.reveal === "1";
  const nameDisplay = revealed ? (p.name ?? "—") : maskName(p.name, false);
  const age = p.dob ? formatAge(calcAge(p.dob, new Date().toISOString().slice(0, 10)).years, null) : "—";
  const loose = samples.filter((s) => !s.visitId);
  const samplesFor = (vid: string) => samples.filter((s) => s.visitId === vid);
  const active = samples.filter((s) => s.status !== "disposed").length;
  const pendingTests = samples.reduce((a, s) => a + s.testCount, 0);
  const savedNote: Record<string, string> = { visit: "Visit saved.", info: "Participant details saved.", consent: "Consent updated." };

  return (
    <div className="max-w-4xl">
      <PageHeader title={p.studyId} subtitle="Participant record" actions={<Link href="/lab/participants" className="btn btn-sm">← Participants</Link>} />
      {sp.added === "visit" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Visit added.</div>}
      {sp.saved && savedNote[sp.saved] && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>{savedNote[sp.saved]}</div>}
      {sp.removed === "visit" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>Visit removed — its samples are kept and unlinked.</div>}
      {sp.err === "label" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A visit label is required.</div>}
      {sp.err === "dupvisit" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A visit with that label already exists for this participant.</div>}
      {sp.err === "forbidden" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Only lab managers can edit participant details or consent.</div>}
      {p.consentStatus === "withdrawn" && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Consent withdrawn{p.withdrawalDate ? ` on ${fmtDate(p.withdrawalDate)}` : ""} — sample retrieval is blocked; flag remaining samples for disposal.</div>}

      {/* Participant info */}
      <div className="card p-4 mb-5">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <Badge tone={consentTone(p.consentStatus)}>consent {label(p.consentStatus)}</Badge>
          {seePII && p.name && !revealed && <Link href={`/lab/participants/${p.id}?reveal=1`} className="text-xs hover:underline" style={{ color: "var(--brand)" }}>Show name</Link>}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Stat label="Name" value={nameDisplay} />
          <Stat label="Age" value={age} />
          <Stat label="Sex" value={p.sex ? label(p.sex) : "—"} />
          <Stat label="Enrolled" value={fmtDate(p.enrollmentDate)} />
          <Stat label="Samples" value={`${active} active`} sub={`${samples.length} total · ${pendingTests} tests`} />
        </div>
        {isAdmin && (
          <div className="flex flex-wrap gap-4 mt-4 pt-3 border-t" style={{ borderColor: "var(--border)" }}>
            <details>
              <summary className="text-xs cursor-pointer hover:underline" style={{ color: "var(--brand)" }}>Edit details</summary>
              <form action={updateParticipantAction} className="grid sm:grid-cols-4 gap-2 items-end mt-2">
                <input type="hidden" name="participantId" value={p.id} />
                <Field label="Name"><input name="name" defaultValue={p.name ?? ""} className="input" /></Field>
                <Field label="Date of birth"><input type="date" name="dob" defaultValue={p.dob ?? ""} className="input" /></Field>
                <Field label="Sex"><select name="sex" defaultValue={p.sex ?? ""} className="select"><option value="">—</option><option value="F">Female</option><option value="M">Male</option><option value="other">Other</option></select></Field>
                <Field label="Enrolled"><input type="date" name="enrollmentDate" defaultValue={p.enrollmentDate} className="input" /></Field>
                <div><button className="btn btn-sm btn-primary" type="submit">Save</button></div>
              </form>
            </details>
            <details>
              <summary className="text-xs cursor-pointer hover:underline" style={{ color: "var(--brand)" }}>Consent</summary>
              <form action={updateParticipantConsentAction} className="flex items-end gap-2 mt-2">
                <input type="hidden" name="participantId" value={p.id} />
                <Field label="Consent status"><select name="consentStatus" defaultValue={p.consentStatus} className="select">{CONSENT.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
                <button className="btn btn-sm" type="submit">Update consent</button>
              </form>
            </details>
          </div>
        )}
      </div>

      {/* Visits with their samples */}
      <SectionTitle>Visits &amp; samples</SectionTitle>
      {visits.length === 0 && loose.length === 0 && <Empty title="No samples yet" hint="Register samples for this participant and assign them to visits to see them grouped here." />}

      {visits.map((v) => {
        const vs = samplesFor(v.id);
        return (
          <div key={v.id} className="card p-4 mb-4">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
              <div className="font-medium">{v.label} {v.visitDate ? <span className="text-sm" style={{ color: "var(--muted)" }}>· {fmtDate(v.visitDate)}</span> : null} {v.sequence != null ? <Badge tone="muted">#{v.sequence}</Badge> : null} <span className="text-xs" style={{ color: "var(--muted)" }}>({vs.length} sample{vs.length === 1 ? "" : "s"})</span></div>
              <details>
                <summary className="text-xs cursor-pointer hover:underline" style={{ color: "var(--brand)" }}>Edit visit</summary>
                <div className="mt-2 flex flex-wrap items-end gap-2">
                  <form action={updateParticipantVisitAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="participantId" value={p.id} /><input type="hidden" name="visitId" value={v.id} />
                    <Field label="Date"><input type="date" name="visitDate" defaultValue={v.visitDate ?? ""} className="input" /></Field>
                    <Field label="Seq"><input type="number" name="sequence" defaultValue={v.sequence ?? ""} className="input" style={{ width: 70 }} /></Field>
                    <Field label="Notes"><input name="notes" defaultValue={v.notes ?? ""} className="input" /></Field>
                    <button className="btn btn-sm" type="submit">Save</button>
                  </form>
                  <form action={deleteParticipantVisitAction}><input type="hidden" name="participantId" value={p.id} /><input type="hidden" name="visitId" value={v.id} /><ConfirmSubmit message="Delete this visit? Its samples are kept but unlinked from the visit." className="text-xs hover:underline" style={{ color: "var(--danger)" }}>delete visit</ConfirmSubmit></form>
                </div>
              </details>
            </div>
            {v.notes && <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>{v.notes}</p>}
            <SampleTable samples={vs} />
          </div>
        );
      })}

      {loose.length > 0 && (
        <div className="card p-4 mb-4">
          <div className="font-medium mb-2">Unscheduled <span className="text-xs" style={{ color: "var(--muted)" }}>({loose.length} sample{loose.length === 1 ? "" : "s"} not assigned to a visit)</span></div>
          <SampleTable samples={loose} />
        </div>
      )}

      {/* Add visit */}
      <div className="card p-4">
        <SectionTitle>Add a visit</SectionTitle>
        <form action={addParticipantVisitAction} className="grid sm:grid-cols-4 gap-2 items-end">
          <input type="hidden" name="participantId" value={p.id} />
          <Field label="Label"><input name="label" required className="input" placeholder="e.g. Day 28, Visit 3" /></Field>
          <Field label="Date"><input type="date" name="visitDate" className="input" /></Field>
          <Field label="Sequence"><input type="number" name="sequence" className="input" placeholder="optional" /></Field>
          <div><button className="btn btn-sm btn-primary" type="submit">Add visit</button></div>
          <div className="sm:col-span-3"><Field label="Notes"><input name="notes" className="input" placeholder="optional" /></Field></div>
        </form>
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Visits also get created automatically when you type a visit label while registering a sample.</p>
      </div>
    </div>
  );
}
