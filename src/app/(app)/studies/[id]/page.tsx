import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireStudiesOrg } from "../_guard";
import { q, one } from "@/server/db";
import { accessibleProjectIds } from "@/server/services/lab";
import { studyEnrollmentTotals, studyAdverseEvents, studyDeviations, studyMonitoringVisits, studyComplianceCounts } from "@/server/services/studies";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Stat, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { deleteStudyAction, addStudySiteAction, addStudyApprovalAction, updateStudyApprovalAction, addStudyVersionAction, addStudyEnrollmentAction, addStudyMilestoneAction, updateStudyMilestoneAction, deleteStudyItemAction, addStudyAEAction, updateStudyAEAction, addStudyDeviationAction, updateStudyDeviationAction, addStudyMonitoringAction, updateStudyMonitoringAction } from "@/app/actions";

function DelBtn({ studyId, kind, id }: { studyId: string; kind: string; id: string }) {
  return (
    <form action={deleteStudyItemAction} className="inline"><input type="hidden" name="studyId" value={studyId} /><input type="hidden" name="kind" value={kind} /><input type="hidden" name="itemId" value={id} />
      <ConfirmSubmit message="Remove this entry?"><button className="text-xs hover:underline" style={{ color: "var(--danger)" }} type="submit">remove</button></ConfirmSubmit>
    </form>
  );
}

export default async function StudyDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudiesOrg();
  const sp = await searchParams;
  const isAdmin = isOrgAdmin || isSuperAdmin;

  const s = await one<{
    id: string; code: string | null; title: string; studyType: string; phase: string | null; design: string | null; blinding: string | null; randomized: boolean; allocationRatio: string | null;
    registry: string | null; registrationNumber: string | null; sponsor: string | null; funder: string | null; piName: string | null; targetEnrollment: number | null; status: string;
    startDate: string | null; endDate: string | null; objectives: string | null; summary: string | null; projectId: string; projectCode: string | null;
  }>(
    `SELECT s.id, s.code, s.title, s.study_type AS "studyType", s.phase, s.design, s.blinding, s.randomized, s.allocation_ratio AS "allocationRatio",
            s.registry, s.registration_number AS "registrationNumber", s.sponsor, s.funder, s.pi_name AS "piName", s.target_enrollment AS "targetEnrollment", s.status,
            s.start_date::text AS "startDate", s.end_date::text AS "endDate", s.objectives, s.summary, s.project_id AS "projectId", p.code AS "projectCode"
     FROM study s LEFT JOIN project p ON p.id=s.project_id WHERE s.id=$1 AND s.org_id=$2`, [id, orgId]
  );
  if (!s) notFound();
  if (!isAdmin) { const ids = await accessibleProjectIds(userId, orgId, false); if (!ids.includes(s.projectId)) redirect("/studies"); }

  const totals = await studyEnrollmentTotals(id);
  const [sites, approvals, versions, enrollment, milestones] = await Promise.all([
    q<{ id: string; name: string; location: string | null; piName: string | null; status: string; target: number | null; activation: string | null }>(`SELECT id, name, location, pi_name AS "piName", status, target_enrollment AS target, activation_date::text AS activation FROM study_site WHERE study_id=$1 ORDER BY created_at`, [id]),
    q<{ id: string; authority: string; authorityName: string | null; ref: string | null; approval: string | null; expiry: string | null; status: string; notes: string | null }>(`SELECT id, authority, authority_name AS "authorityName", reference_number AS ref, approval_date::text AS approval, expiry_date::text AS expiry, status, notes FROM study_approval WHERE study_id=$1 ORDER BY created_at`, [id]),
    q<{ id: string; docType: string; version: string; vdate: string | null; language: string | null; status: string; summary: string | null }>(`SELECT id, doc_type AS "docType", version, version_date::text AS vdate, language, status, summary FROM study_version WHERE study_id=$1 ORDER BY created_at DESC`, [id]),
    q<{ id: string; siteName: string | null; asOf: string; screened: number; enrolled: number; withdrawn: number; completed: number; note: string | null }>(`SELECT e.id, st.name AS "siteName", e.as_of_date::text AS "asOf", e.screened, e.enrolled, e.withdrawn, e.completed, e.note FROM study_enrollment e LEFT JOIN study_site st ON st.id=e.site_id WHERE e.study_id=$1 ORDER BY e.as_of_date DESC, e.created_at DESC`, [id]),
    q<{ id: string; name: string; planned: string | null; actual: string | null; status: string; note: string | null }>(`SELECT id, name, planned_date::text AS planned, actual_date::text AS actual, status, note FROM study_milestone WHERE study_id=$1 ORDER BY COALESCE(planned_date, actual_date) NULLS LAST, created_at`, [id]),
  ]);

  const pct = s.targetEnrollment && s.targetEnrollment > 0 ? Math.min(100, Math.round((totals.enrolled / s.targetEnrollment) * 100)) : 0;
  const [aes, deviations, monitoring, comp] = await Promise.all([studyAdverseEvents(id), studyDeviations(id), studyMonitoringVisits(id), studyComplianceCounts(id)]);
  const notes: Record<string, string> = { site: "Site added.", approval: "Approval added.", version: "Version added.", enrollment: "Enrollment updated.", milestone: "Milestone added.", ae: "Adverse event recorded.", deviation: "Deviation logged.", monitoring: "Monitoring visit recorded." };
  const savedNotes: Record<string, string> = { ae: "Adverse event updated.", deviation: "Deviation updated.", monitoring: "Monitoring visit updated." };

  return (
    <div className="max-w-5xl">
      <PageHeader title={`${s.code ? s.code + " — " : ""}${s.title}`} subtitle={`${label(s.studyType)}${s.phase && s.phase !== "NA" ? ` · Phase ${s.phase}` : ""}${s.projectCode ? ` · ${s.projectCode}` : ""}`}
        actions={<div className="flex gap-2"><Link href={`/studies/${s.id}/edit`} className="btn btn-sm">Edit</Link>{isAdmin && (
          <form action={deleteStudyAction} className="inline"><input type="hidden" name="studyId" value={s.id} /><ConfirmSubmit message="Delete this study and all its sites, approvals, versions, enrollment and milestones? This cannot be undone."><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button></ConfirmSubmit></form>
        )}<Link href="/studies" className="btn btn-sm">← Studies</Link></div>} />

      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Study created.</div>}
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.added && notes[sp.added] && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>{notes[sp.added]}</div>}
      {sp.saved && savedNotes[sp.saved] && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>{savedNotes[sp.saved]}</div>}
      {sp.removed && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>Entry removed.</div>}
      {(comp.openSAEs > 0 || comp.majorDeviations > 0 || comp.openMonitoring > 0) && (
        <div className="card p-3 mb-4 text-sm" style={{ color: comp.openSAEs > 0 || comp.majorDeviations > 0 ? "var(--danger)" : "var(--warn)", borderColor: comp.openSAEs > 0 || comp.majorDeviations > 0 ? "var(--danger)" : "var(--warn)" }}>
          Safety &amp; compliance: {[comp.openSAEs > 0 ? `${comp.openSAEs} open SAE${comp.openSAEs === 1 ? "" : "s"}` : null, comp.majorDeviations > 0 ? `${comp.majorDeviations} unresolved major deviation${comp.majorDeviations === 1 ? "" : "s"}` : null, comp.openMonitoring > 0 ? `${comp.openMonitoring} open monitoring visit${comp.openMonitoring === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}.
        </div>
      )}

      {/* Overview */}
      <div className="card p-4 mb-5">
        <div className="flex items-center gap-2 flex-wrap mb-3"><StatusBadge status={s.status} />{s.randomized && <Badge tone="info">randomized</Badge>}{s.blinding && s.blinding !== "NA" && <Badge tone="muted">{label(s.blinding)}</Badge>}</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <Stat label="Target" value={s.targetEnrollment != null ? String(s.targetEnrollment) : "—"} />
          <Stat label="Enrolled" value={String(totals.enrolled)} sub={s.targetEnrollment ? `${pct}% of target` : undefined} />
          <Stat label="Active" value={String(totals.active)} />
          <Stat label="Withdrawn" value={String(totals.withdrawn)} />
        </div>
        <div className="grid sm:grid-cols-2 gap-y-1 text-sm">
          {s.design && <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Design: </span>{s.design}</div>}
          <div><span style={{ color: "var(--muted)" }}>Registry: </span>{s.registry ? `${s.registry}${s.registrationNumber ? ` · ${s.registrationNumber}` : ""}` : "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>PI: </span>{s.piName ?? "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Sponsor: </span>{s.sponsor ?? "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Funder: </span>{s.funder ?? "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Period: </span>{s.startDate ? fmtDate(s.startDate) : "—"} → {s.endDate ? fmtDate(s.endDate) : "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Allocation: </span>{s.allocationRatio ?? "—"}</div>
          {s.objectives && <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Objectives: </span>{s.objectives}</div>}
          {s.summary && <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Summary: </span>{s.summary}</div>}
        </div>
      </div>

      {/* Enrollment */}
      <div className="card p-4 mb-5">
        <SectionTitle>Enrollment</SectionTitle>
        {s.targetEnrollment ? (
          <div className="mb-3"><div className="flex justify-between text-xs mb-1"><span style={{ color: "var(--muted)" }}>{totals.enrolled} enrolled of {s.targetEnrollment}</span><span className="tabular-nums">{pct}%</span></div>
            <div style={{ height: 10, borderRadius: 5, background: "var(--border)" }}><div style={{ width: `${pct}%`, height: "100%", borderRadius: 5, background: "var(--brand)" }} /></div></div>
        ) : null}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mb-3 text-sm">
          <div><span style={{ color: "var(--muted)" }}>Screened</span><div className="font-medium tabular-nums">{totals.screened}</div></div>
          <div><span style={{ color: "var(--muted)" }}>Enrolled</span><div className="font-medium tabular-nums">{totals.enrolled}</div></div>
          <div><span style={{ color: "var(--muted)" }}>Active</span><div className="font-medium tabular-nums">{totals.active}</div></div>
          <div><span style={{ color: "var(--muted)" }}>Withdrawn</span><div className="font-medium tabular-nums">{totals.withdrawn}</div></div>
          <div><span style={{ color: "var(--muted)" }}>Completed</span><div className="font-medium tabular-nums">{totals.completed}</div></div>
        </div>
        {enrollment.length > 0 && (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">As of</th><th className="th text-left">Site</th><th className="th text-right">Screened</th><th className="th text-right">Enrolled</th><th className="th text-right">Withdrawn</th><th className="th text-right">Completed</th><th className="th text-left">Note</th><th className="th" /></tr></thead>
            <tbody>{enrollment.map((e) => (<tr key={e.id}><td className="td whitespace-nowrap">{fmtDate(e.asOf)}</td><td className="td">{e.siteName ?? "All"}</td><td className="td text-right tabular-nums">{e.screened}</td><td className="td text-right tabular-nums">{e.enrolled}</td><td className="td text-right tabular-nums">{e.withdrawn}</td><td className="td text-right tabular-nums">{e.completed}</td><td className="td">{e.note ?? ""}</td><td className="td text-right"><DelBtn studyId={s.id} kind="enrollment" id={e.id} /></td></tr>))}</tbody>
          </table></div>
        )}
        <form action={addStudyEnrollmentAction} className="grid sm:grid-cols-6 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="studyId" value={s.id} />
          <Field label="As of"><input type="date" name="asOfDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
          <Field label="Site"><select name="siteId" className="select"><option value="">All</option>{sites.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}</select></Field>
          <Field label="Screened"><input type="number" min={0} name="screened" defaultValue={0} className="input" /></Field>
          <Field label="Enrolled"><input type="number" min={0} name="enrolled" defaultValue={0} className="input" /></Field>
          <Field label="Withdrawn"><input type="number" min={0} name="withdrawn" defaultValue={0} className="input" /></Field>
          <div className="flex gap-2"><Field label="Completed"><input type="number" min={0} name="completed" defaultValue={0} className="input" /></Field><button className="btn btn-sm btn-primary" type="submit" style={{ alignSelf: "flex-end" }}>Add</button></div>
        </form>
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Add periodic counts — totals are summed across entries. This tracks numbers, not individual participant data.</p>
      </div>

      {/* Approvals */}
      <div className="card p-4 mb-5">
        <SectionTitle>Regulatory & ethics approvals</SectionTitle>
        {approvals.length === 0 ? <Empty title="No approvals recorded" hint="Record REC, NDA and UNCST approvals and their expiry dates." /> : (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Authority</th><th className="th text-left">Reference</th><th className="th text-left">Approved</th><th className="th text-left">Expires</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>{approvals.map((a) => {
              const expSoon = a.expiry && a.status === "approved" && (new Date(a.expiry).getTime() - Date.now()) / 86400000 <= 60;
              return (<tr key={a.id}>
                <td className="td">{label(a.authority)}{a.authorityName ? <div className="text-xs" style={{ color: "var(--muted)" }}>{a.authorityName}</div> : null}</td>
                <td className="td">{a.ref ?? "—"}</td><td className="td whitespace-nowrap">{a.approval ? fmtDate(a.approval) : "—"}</td>
                <td className="td whitespace-nowrap">{a.expiry ? fmtDate(a.expiry) : "—"}{expSoon && <Badge tone="warn">soon</Badge>}</td>
                <td className="td"><StatusBadge status={a.status} /></td>
                <td className="td text-right">
                  <form action={updateStudyApprovalAction} className="inline-flex items-center gap-1 mr-2"><input type="hidden" name="studyId" value={s.id} /><input type="hidden" name="approvalId" value={a.id} />
                    <select name="apprStatus" defaultValue={a.status} className="select" style={{ padding: "2px 6px", fontSize: 12 }}><option value="pending">Pending</option><option value="approved">Approved</option><option value="expired">Expired</option><option value="suspended">Suspended</option><option value="withdrawn">Withdrawn</option></select>
                    <button className="text-xs hover:underline" type="submit" style={{ color: "var(--brand)" }}>set</button>
                  </form>
                  <DelBtn studyId={s.id} kind="approval" id={a.id} />
                </td>
              </tr>);
            })}</tbody>
          </table></div>
        )}
        <form action={addStudyApprovalAction} className="grid sm:grid-cols-6 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="studyId" value={s.id} />
          <Field label="Authority"><select name="authority" className="select"><option value="REC">REC</option><option value="NDA">NDA</option><option value="UNCST">UNCST</option><option value="sponsor">Sponsor</option><option value="other">Other</option></select></Field>
          <Field label="Committee/name"><input name="authorityName" className="input" placeholder="e.g. SOMREC" /></Field>
          <Field label="Reference no."><input name="referenceNumber" className="input" /></Field>
          <Field label="Approved"><input type="date" name="approvalDate" className="input" /></Field>
          <Field label="Expires"><input type="date" name="expiryDate" className="input" /></Field>
          <div className="flex gap-2"><Field label="Status"><select name="apprStatus" defaultValue="approved" className="select"><option value="pending">Pending</option><option value="approved">Approved</option><option value="expired">Expired</option></select></Field><button className="btn btn-sm btn-primary" type="submit" style={{ alignSelf: "flex-end" }}>Add</button></div>
        </form>
      </div>

      {/* Sites */}
      <div className="card p-4 mb-5">
        <SectionTitle>Sites</SectionTitle>
        {sites.length > 0 && (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Site</th><th className="th text-left">Location</th><th className="th text-left">PI</th><th className="th text-left">Target</th><th className="th text-left">Activated</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>{sites.map((st) => (<tr key={st.id}><td className="td">{st.name}</td><td className="td">{st.location ?? "—"}</td><td className="td">{st.piName ?? "—"}</td><td className="td tabular-nums">{st.target ?? "—"}</td><td className="td whitespace-nowrap">{st.activation ? fmtDate(st.activation) : "—"}</td><td className="td"><StatusBadge status={st.status} /></td><td className="td text-right"><DelBtn studyId={s.id} kind="site" id={st.id} /></td></tr>))}</tbody>
          </table></div>
        )}
        <form action={addStudySiteAction} className="grid sm:grid-cols-6 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="studyId" value={s.id} />
          <Field label="Site name"><input name="name" required className="input" /></Field>
          <Field label="Location"><input name="location" className="input" /></Field>
          <Field label="Site PI"><input name="sitePiName" className="input" /></Field>
          <Field label="Target"><input type="number" min={0} name="siteTarget" className="input" /></Field>
          <Field label="Activated"><input type="date" name="activationDate" className="input" /></Field>
          <div className="flex gap-2"><Field label="Status"><select name="siteStatus" defaultValue="pending" className="select"><option value="pending">Pending</option><option value="active">Active</option><option value="closed">Closed</option><option value="suspended">Suspended</option></select></Field><button className="btn btn-sm btn-primary" type="submit" style={{ alignSelf: "flex-end" }}>Add</button></div>
        </form>
      </div>

      {/* Protocol & consent versions */}
      <div className="card p-4 mb-5">
        <SectionTitle>Protocol & consent versions</SectionTitle>
        {versions.length > 0 && (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Document</th><th className="th text-left">Version</th><th className="th text-left">Date</th><th className="th text-left">Status</th><th className="th text-left">Summary</th><th className="th" /></tr></thead>
            <tbody>{versions.map((v) => (<tr key={v.id}><td className="td">{label(v.docType)}{v.language ? <span style={{ color: "var(--muted)" }}> · {v.language}</span> : null}</td><td className="td font-mono text-xs">{v.version}</td><td className="td whitespace-nowrap">{v.vdate ? fmtDate(v.vdate) : "—"}</td><td className="td"><StatusBadge status={v.status} /></td><td className="td">{v.summary ?? ""}</td><td className="td text-right"><DelBtn studyId={s.id} kind="version" id={v.id} /></td></tr>))}</tbody>
          </table></div>
        )}
        <form action={addStudyVersionAction} className="grid sm:grid-cols-6 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="studyId" value={s.id} />
          <Field label="Document"><select name="docType" className="select"><option value="protocol">Protocol</option><option value="consent">Consent form</option><option value="sap">SAP</option><option value="other">Other</option></select></Field>
          <Field label="Version"><input name="version" required className="input" placeholder="e.g. 2.0" /></Field>
          <Field label="Date"><input type="date" name="versionDate" className="input" /></Field>
          <Field label="Language"><input name="language" className="input" placeholder="e.g. English" /></Field>
          <Field label="Status"><select name="verStatus" defaultValue="approved" className="select"><option value="draft">Draft</option><option value="submitted">Submitted</option><option value="approved">Approved</option><option value="active">Active</option><option value="superseded">Superseded</option></select></Field>
          <div className="flex gap-2"><Field label="Summary"><input name="verSummary" className="input" placeholder="changes" /></Field><button className="btn btn-sm btn-primary" type="submit" style={{ alignSelf: "flex-end" }}>Add</button></div>
        </form>
      </div>

      {/* Milestones */}
      <div className="card p-4 mb-5">
        <SectionTitle>Milestones</SectionTitle>
        {milestones.length > 0 && (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Milestone</th><th className="th text-left">Planned</th><th className="th text-left">Actual</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>{milestones.map((m) => (<tr key={m.id}><td className="td">{m.name}{m.note ? <div className="text-xs" style={{ color: "var(--muted)" }}>{m.note}</div> : null}</td><td className="td whitespace-nowrap">{m.planned ? fmtDate(m.planned) : "—"}</td><td className="td whitespace-nowrap">{m.actual ? fmtDate(m.actual) : "—"}</td><td className="td"><StatusBadge status={m.status} /></td>
              <td className="td text-right">
                <form action={updateStudyMilestoneAction} className="inline-flex items-center gap-1 mr-2"><input type="hidden" name="studyId" value={s.id} /><input type="hidden" name="milestoneId" value={m.id} />
                  <select name="msStatus" defaultValue={m.status} className="select" style={{ padding: "2px 6px", fontSize: 12 }}><option value="pending">Pending</option><option value="done">Done</option><option value="missed">Missed</option></select>
                  <button className="text-xs hover:underline" type="submit" style={{ color: "var(--brand)" }}>set</button>
                </form>
                <DelBtn studyId={s.id} kind="milestone" id={m.id} />
              </td></tr>))}</tbody>
          </table></div>
        )}
        <form action={addStudyMilestoneAction} className="grid sm:grid-cols-5 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="studyId" value={s.id} />
          <Field label="Milestone"><input name="name" required className="input" placeholder="e.g. First Participant In" /></Field>
          <Field label="Planned"><input type="date" name="plannedDate" className="input" /></Field>
          <Field label="Actual"><input type="date" name="actualDate" className="input" /></Field>
          <Field label="Status"><select name="msStatus" defaultValue="pending" className="select"><option value="pending">Pending</option><option value="done">Done</option><option value="missed">Missed</option></select></Field>
          <div className="flex gap-2"><Field label="Note"><input name="note" className="input" /></Field><button className="btn btn-sm btn-primary" type="submit" style={{ alignSelf: "flex-end" }}>Add</button></div>
        </form>
      </div>

      {/* Safety — adverse events / SAE register */}
      <div className="card p-4 mb-5">
        <SectionTitle>Safety — adverse events</SectionTitle>
        <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Adverse event and serious adverse event (SAE) register. SAEs and unresolved events surface in the alert above.</p>
        {aes.length > 0 && (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Event</th><th className="th text-left">Subject</th><th className="th text-left">Onset</th><th className="th text-left">Severity</th><th className="th text-left">Causality</th><th className="th text-left">Outcome</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>{aes.map((a) => (
              <tr key={a.id}>
                <td className="td">{a.term}{a.serious && <Badge tone="danger">SAE</Badge>}{a.serious && a.saeCriteria ? <div className="text-xs" style={{ color: "var(--muted)" }}>{label(a.saeCriteria)}</div> : null}</td>
                <td className="td">{a.participantRef ?? "—"}</td>
                <td className="td whitespace-nowrap">{a.onsetDate ? fmtDate(a.onsetDate) : "—"}</td>
                <td className="td"><Badge tone={a.severity === "severe" ? "danger" : a.severity === "moderate" ? "warn" : "muted"}>{label(a.severity)}</Badge></td>
                <td className="td">{a.causality ? label(a.causality) : "—"}{a.expectedness ? <div className="text-xs" style={{ color: "var(--muted)" }}>{label(a.expectedness)}</div> : null}</td>
                <td className="td">{a.outcome ? label(a.outcome) : "—"}</td>
                <td className="td"><StatusBadge status={a.status} /></td>
                <td className="td text-right">
                  <form action={updateStudyAEAction} className="inline-flex items-center gap-1 mr-2"><input type="hidden" name="studyId" value={s.id} /><input type="hidden" name="aeId" value={a.id} />
                    <select name="status" defaultValue={a.status} className="select" style={{ padding: "2px 6px", fontSize: 12 }}><option value="open">Open</option><option value="followed_up">Followed up</option><option value="reported">Reported</option><option value="resolved">Resolved</option></select>
                    <button className="text-xs hover:underline" type="submit" style={{ color: "var(--brand)" }}>set</button>
                  </form>
                  <DelBtn studyId={s.id} kind="ae" id={a.id} />
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <form action={addStudyAEAction} className="grid sm:grid-cols-4 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="studyId" value={s.id} />
          <Field label="Event term"><input name="term" required className="input" placeholder="e.g. Fever" /></Field>
          <Field label="Subject ref"><input name="participantRef" className="input" placeholder="screening ID" /></Field>
          <Field label="Onset"><input type="date" name="onsetDate" className="input" /></Field>
          <Field label="Severity"><select name="severity" defaultValue="mild" className="select"><option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option></select></Field>
          <Field label="Serious (SAE)?"><select name="serious" defaultValue="0" className="select"><option value="0">No</option><option value="1">Yes</option></select></Field>
          <Field label="SAE criterion"><select name="saeCriteria" className="select"><option value="">—</option>{["death", "life_threatening", "hospitalization", "disability", "congenital_anomaly", "other"].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          <Field label="Causality"><select name="causality" className="select"><option value="">—</option>{["unrelated", "unlikely", "possible", "probable", "definite"].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          <Field label="Expectedness"><select name="expectedness" className="select"><option value="">—</option><option value="expected">Expected</option><option value="unexpected">Unexpected</option></select></Field>
          <Field label="Outcome"><select name="outcome" className="select"><option value="">—</option>{["recovered", "recovering", "ongoing", "recovered_sequelae", "fatal", "unknown"].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          <Field label="Reported to"><select name="reportedTo" className="select"><option value="">—</option>{["REC", "NDA", "sponsor", "other"].map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
          <Field label="Reported date"><input type="date" name="reportedDate" className="input" /></Field>
          <div><button className="btn btn-sm btn-primary" type="submit">Record event</button></div>
        </form>
      </div>

      {/* Protocol deviations */}
      <div className="card p-4 mb-5">
        <SectionTitle>Protocol deviations</SectionTitle>
        {deviations.length > 0 && (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Date</th><th className="th text-left">Type</th><th className="th text-left">Severity</th><th className="th text-left">Description</th><th className="th text-left">Reported</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>{deviations.map((d) => (
              <tr key={d.id}>
                <td className="td whitespace-nowrap">{d.deviationDate ? fmtDate(d.deviationDate) : "—"}</td>
                <td className="td">{label(d.kind)}{d.participantRef ? <div className="text-xs" style={{ color: "var(--muted)" }}>{d.participantRef}</div> : null}</td>
                <td className="td"><Badge tone={d.severity === "major" ? "danger" : "muted"}>{label(d.severity)}</Badge></td>
                <td className="td">{d.description}{d.correctiveAction ? <div className="text-xs" style={{ color: "var(--muted)" }}>CAPA: {d.correctiveAction}</div> : null}</td>
                <td className="td">{d.reported ? <Badge tone="ok">yes</Badge> : <Badge tone="warn">no</Badge>}</td>
                <td className="td"><StatusBadge status={d.status} /></td>
                <td className="td text-right">
                  <form action={updateStudyDeviationAction} className="inline-flex items-center gap-1 mr-2"><input type="hidden" name="studyId" value={s.id} /><input type="hidden" name="deviationId" value={d.id} /><input type="hidden" name="reported" value={d.reported ? "1" : "0"} />
                    <select name="status" defaultValue={d.status} className="select" style={{ padding: "2px 6px", fontSize: 12 }}><option value="open">Open</option><option value="capa">CAPA</option><option value="resolved">Resolved</option></select>
                    <button className="text-xs hover:underline" type="submit" style={{ color: "var(--brand)" }}>set</button>
                  </form>
                  <DelBtn studyId={s.id} kind="deviation" id={d.id} />
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <form action={addStudyDeviationAction} className="grid sm:grid-cols-4 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="studyId" value={s.id} />
          <Field label="Date"><input type="date" name="deviationDate" className="input" /></Field>
          <Field label="Type"><select name="kind" defaultValue="other" className="select">{["eligibility", "consent", "visit_window", "procedure", "ip_handling", "sae_reporting", "other"].map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          <Field label="Severity"><select name="severity" defaultValue="minor" className="select"><option value="minor">Minor</option><option value="major">Major</option></select></Field>
          <Field label="Subject ref"><input name="participantRef" className="input" placeholder="optional" /></Field>
          <div className="sm:col-span-3"><Field label="Description"><input name="description" required className="input" placeholder="What happened" /></Field></div>
          <div><button className="btn btn-sm btn-primary" type="submit">Log deviation</button></div>
          <div className="sm:col-span-2"><Field label="Corrective action (CAPA)"><input name="correctiveAction" className="input" placeholder="optional" /></Field></div>
          <Field label="Reported to REC/sponsor?"><select name="reported" defaultValue="0" className="select"><option value="0">No</option><option value="1">Yes</option></select></Field>
        </form>
      </div>

      {/* Monitoring visits */}
      <div className="card p-4 mb-5">
        <SectionTitle>Monitoring visits</SectionTitle>
        {monitoring.length > 0 && (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Date</th><th className="th text-left">Type</th><th className="th text-left">Monitor</th><th className="th text-left">Findings</th><th className="th text-left">Report</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>{monitoring.map((m) => (
              <tr key={m.id}>
                <td className="td whitespace-nowrap">{m.visitDate ? fmtDate(m.visitDate) : "—"}</td>
                <td className="td">{label(m.kind)}{m.site ? <div className="text-xs" style={{ color: "var(--muted)" }}>{m.site}</div> : null}</td>
                <td className="td">{m.monitorName ?? "—"}</td>
                <td className="td">{m.findings ?? ""}{m.actionItems ? <div className="text-xs" style={{ color: "var(--muted)" }}>Actions: {m.actionItems}</div> : null}</td>
                <td className="td">{m.reportReceived ? <Badge tone="ok">received</Badge> : <Badge tone="muted">pending</Badge>}</td>
                <td className="td"><StatusBadge status={m.status} /></td>
                <td className="td text-right">
                  <form action={updateStudyMonitoringAction} className="inline-flex items-center gap-1 mr-2"><input type="hidden" name="studyId" value={s.id} /><input type="hidden" name="monitoringId" value={m.id} /><input type="hidden" name="reportReceived" value={m.reportReceived ? "1" : "0"} />
                    <select name="status" defaultValue={m.status} className="select" style={{ padding: "2px 6px", fontSize: 12 }}><option value="scheduled">Scheduled</option><option value="open">Open</option><option value="actions_pending">Actions pending</option><option value="closed">Closed</option></select>
                    <button className="text-xs hover:underline" type="submit" style={{ color: "var(--brand)" }}>set</button>
                  </form>
                  <DelBtn studyId={s.id} kind="monitoring" id={m.id} />
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <form action={addStudyMonitoringAction} className="grid sm:grid-cols-4 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="studyId" value={s.id} />
          <Field label="Visit date"><input type="date" name="visitDate" className="input" /></Field>
          <Field label="Type"><select name="kind" defaultValue="imv" className="select"><option value="siv">Site initiation</option><option value="imv">Interim monitoring</option><option value="cov">Close-out</option><option value="for_cause">For cause</option><option value="remote">Remote</option></select></Field>
          <Field label="Monitor"><input name="monitorName" className="input" placeholder="name" /></Field>
          <Field label="Site"><input name="site" className="input" placeholder="optional" /></Field>
          <div className="sm:col-span-2"><Field label="Findings"><input name="findings" className="input" placeholder="summary" /></Field></div>
          <div className="sm:col-span-2"><Field label="Action items"><input name="actionItems" className="input" placeholder="optional" /></Field></div>
          <Field label="Report received?"><select name="reportReceived" defaultValue="0" className="select"><option value="0">No</option><option value="1">Yes</option></select></Field>
          <div><button className="btn btn-sm btn-primary" type="submit">Add visit</button></div>
        </form>
      </div>
    </div>
  );
}
