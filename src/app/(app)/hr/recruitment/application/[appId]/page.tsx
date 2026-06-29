import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHrOrg } from "../../../_guard";
import { getApplication, listInterviews, listScores, getOffer } from "@/server/services/recruitment";
import { PageHeader, SectionTitle, Field, StatusBadge, Badge, Empty } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { currencyOptions } from "@/lib/currencies";
import {
  moveApplicationStageAction, rejectApplicationAction, withdrawApplicationAction,
  scheduleInterviewAction, setInterviewStatusAction, addInterviewScoreAction,
  createOfferAction, setOfferStatusAction, hireApplicantAction,
} from "@/app/actions";

const MOVE_STAGES = ["applied", "screening", "shortlisted", "interview", "offer"];
const KINDS = ["phone_screen", "technical", "panel", "final"];
const MODES = ["in_person", "video", "phone"];
const RATING = [1, 2, 3, 4, 5];
const scoreAvg = (s: { technical: number | null; experience: number | null; communication: number | null; motivation: number | null }) => {
  const vals = [s.technical, s.experience, s.communication, s.motivation].filter((v): v is number => v != null);
  return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
};

export default async function ApplicationPage({ params, searchParams }: { params: Promise<{ appId: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId } = await requireHrOrg();
  const { appId } = await params;
  const app = await getApplication(orgId, appId);
  if (!app) notFound();
  const interviews = await listInterviews(orgId, appId);
  const scoresByInterview = await Promise.all(interviews.map((i) => listScores(orgId, i.id)));
  const offer = await getOffer(orgId, appId);
  const terminal = app.stage === "rejected" || app.stage === "withdrawn" || app.stage === "hired";

  return (
    <div className="max-w-4xl">
      <PageHeader title={app.fullName} subtitle={`Applicant — ${app.openingTitle}`} actions={<Link href={`/hr/recruitment/${app.openingId}`} className="btn btn-sm">← Opening</Link>} />

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <StatusBadge status={app.stage} />
        {app.appliedDate && <span className="text-sm" style={{ color: "var(--muted)" }}>Applied {fmtDate(app.appliedDate)}</span>}
        {app.cvKey && <a href={`/api/candidate-cv/${app.candidateId}`} className="text-sm hover:underline" style={{ color: "var(--brand)" }}>Download CV{app.cvName ? ` (${app.cvName})` : ""}</a>}
        {app.hiredEmployeeId && <Link href={`/hr/employees/${app.hiredEmployeeId}`} className="text-sm hover:underline" style={{ color: "var(--ok)" }}>View employee record →</Link>}
      </div>

      {/* Candidate */}
      <div className="card p-4 mb-5 grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
        {app.email && <div><span className="label">Email</span> {app.email}</div>}
        {app.phone && <div><span className="label">Phone</span> {app.phone}</div>}
        {app.currentTitle && <div><span className="label">Current role</span> {app.currentTitle}{app.currentEmployer ? ` @ ${app.currentEmployer}` : ""}</div>}
        {app.highestQualification && <div><span className="label">Qualification</span> {app.highestQualification}</div>}
        {app.yearsExperience != null && <div><span className="label">Experience</span> {app.yearsExperience} yrs</div>}
        {app.source && <div><span className="label">Source</span> {label(app.source)}</div>}
        {app.location && <div><span className="label">Location</span> {app.location}</div>}
        {app.coverNote && <div className="sm:col-span-2"><span className="label">Cover note</span><p className="whitespace-pre-wrap">{app.coverNote}</p></div>}
        {app.rejectionReason && <div className="sm:col-span-2" style={{ color: "var(--danger)" }}><span className="label">Rejection reason</span> {app.rejectionReason}</div>}
      </div>

      {/* Stage controls */}
      {!terminal && (
        <div className="card p-4 mb-5">
          <SectionTitle>Move through pipeline</SectionTitle>
          <div className="flex flex-wrap gap-3 mt-2 items-end">
            <form action={moveApplicationStageAction} className="flex items-end gap-2">
              <input type="hidden" name="applicationId" value={appId} />
              <Field label="Stage"><select name="stage" defaultValue={app.stage} className="select select-sm">{MOVE_STAGES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
              <button className="btn btn-sm btn-primary" type="submit">Move</button>
            </form>
            <form action={withdrawApplicationAction}><input type="hidden" name="applicationId" value={appId} /><button className="btn btn-sm" type="submit">Mark withdrawn</button></form>
            <form action={rejectApplicationAction} className="flex items-end gap-2 ml-auto">
              <input type="hidden" name="applicationId" value={appId} />
              <Field label="Reject — reason"><input name="reason" className="input input-sm" placeholder="optional" /></Field>
              <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Reject</button>
            </form>
          </div>
        </div>
      )}

      {/* Interviews */}
      <SectionTitle>Interviews & scorecards</SectionTitle>
      <div className="space-y-3 mt-2 mb-4">
        {interviews.length === 0 && <Empty title="No interviews scheduled" hint="Schedule one below." />}
        {interviews.map((iv, idx) => {
          const scores = scoresByInterview[idx];
          return (
            <div key={iv.id} className="card p-4">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="font-medium">Round {iv.round} · {label(iv.kind)} <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>({label(iv.mode)})</span></div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={iv.status} />
                  {iv.avgScore != null && <Badge tone="info">avg {iv.avgScore}/5</Badge>}
                </div>
              </div>
              <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>{iv.scheduledAt ? fmtDateTime(iv.scheduledAt) : "Not scheduled"}{iv.location ? ` · ${iv.location}` : ""}</div>

              {scores.length > 0 && (
                <div className="overflow-x-auto mt-3">
                  <table className="w-full text-xs">
                    <thead><tr><th className="th text-left">Panelist</th><th className="th">Tech</th><th className="th">Exp</th><th className="th">Comm</th><th className="th">Motiv</th><th className="th">Avg</th><th className="th text-left">Recommendation</th><th className="th">COI</th></tr></thead>
                    <tbody>
                      {scores.map((s) => (
                        <tr key={s.id}>
                          <td className="td">{s.panelist}{s.comments ? <div style={{ color: "var(--muted)" }}>{s.comments}</div> : null}</td>
                          <td className="td text-center">{s.technical ?? "—"}</td>
                          <td className="td text-center">{s.experience ?? "—"}</td>
                          <td className="td text-center">{s.communication ?? "—"}</td>
                          <td className="td text-center">{s.motivation ?? "—"}</td>
                          <td className="td text-center tabular-nums">{scoreAvg(s) ?? "—"}</td>
                          <td className="td">{s.recommendation ? label(s.recommendation) : "—"}</td>
                          <td className="td text-center">{s.coiDeclared ? "⚠" : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {!terminal && (
                <details className="mt-3">
                  <summary className="text-sm cursor-pointer" style={{ color: "var(--brand)" }}>+ Add scorecard</summary>
                  <form action={addInterviewScoreAction} className="grid sm:grid-cols-3 gap-2 mt-2">
                    <input type="hidden" name="interviewId" value={iv.id} />
                    <input type="hidden" name="applicationId" value={appId} />
                    <Field label="Panelist *"><input name="panelist" required className="input input-sm" /></Field>
                    <Field label="Technical"><select name="technical" defaultValue="3" className="select select-sm">{RATING.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
                    <Field label="Experience"><select name="experience" defaultValue="3" className="select select-sm">{RATING.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
                    <Field label="Communication"><select name="communication" defaultValue="3" className="select select-sm">{RATING.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
                    <Field label="Motivation / fit"><select name="motivation" defaultValue="3" className="select select-sm">{RATING.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
                    <Field label="Recommendation"><select name="recommendation" className="select select-sm"><option value="">—</option><option value="recommend">Recommend</option><option value="maybe">Maybe</option><option value="do_not_recommend">Do not recommend</option></select></Field>
                    <div className="sm:col-span-2"><Field label="Comments"><input name="comments" className="input input-sm" /></Field></div>
                    <label className="flex items-center gap-2 text-xs mt-5"><input type="checkbox" name="coiDeclared" /> Conflict of interest declared</label>
                    <div className="sm:col-span-3"><button className="btn btn-sm btn-primary" type="submit">Save scorecard</button></div>
                  </form>
                </details>
              )}

              {!terminal && iv.status === "scheduled" && (
                <form action={setInterviewStatusAction} className="mt-2 flex gap-2">
                  <input type="hidden" name="interviewId" value={iv.id} /><input type="hidden" name="applicationId" value={appId} />
                  <button className="btn btn-sm" name="status" value="completed" type="submit">Mark completed</button>
                  <button className="btn btn-sm" name="status" value="no_show" type="submit">No-show</button>
                  <button className="btn btn-sm" name="status" value="cancelled" type="submit">Cancel</button>
                </form>
              )}
            </div>
          );
        })}
      </div>

      {!terminal && (
        <details className="card p-4 mb-5">
          <summary className="text-sm font-medium cursor-pointer">+ Schedule interview</summary>
          <form action={scheduleInterviewAction} className="grid sm:grid-cols-3 gap-2 mt-3">
            <input type="hidden" name="applicationId" value={appId} />
            <Field label="Round"><input name="round" type="number" min="1" defaultValue={String(interviews.length + 1)} className="input input-sm" /></Field>
            <Field label="Type"><select name="kind" defaultValue="panel" className="select select-sm">{KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
            <Field label="Mode"><select name="mode" defaultValue="in_person" className="select select-sm">{MODES.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></Field>
            <Field label="When"><input name="scheduledAt" type="datetime-local" className="input input-sm" /></Field>
            <Field label="Location / link"><input name="location" className="input input-sm" /></Field>
            <div className="sm:col-span-3"><button className="btn btn-sm btn-primary" type="submit">Schedule</button></div>
          </form>
        </details>
      )}

      {/* Offer + hire */}
      <SectionTitle>Offer</SectionTitle>
      <div className="card p-4 mt-2">
        {offer ? (
          <>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="text-sm">
                <StatusBadge status={offer.status} />{" "}
                {offer.salary != null && <span className="tabular-nums">{money(offer.salary, offer.currency ?? "USD")}</span>}
                {offer.employmentType && <span style={{ color: "var(--muted)" }}> · {label(offer.employmentType)}</span>}
                {offer.startDate && <span style={{ color: "var(--muted)" }}> · starts {fmtDate(offer.startDate)}</span>}
              </div>
              {offer.status !== "accepted" && offer.status !== "declined" && (
                <form action={setOfferStatusAction} className="flex gap-2">
                  <input type="hidden" name="offerId" value={offer.id} /><input type="hidden" name="applicationId" value={appId} />
                  {offer.status === "draft" && <button className="btn btn-sm" name="status" value="sent" type="submit">Mark sent</button>}
                  <button className="btn btn-sm" name="status" value="accepted" type="submit" style={{ color: "var(--ok)" }}>Accepted</button>
                  <button className="btn btn-sm" name="status" value="declined" type="submit" style={{ color: "var(--danger)" }}>Declined</button>
                </form>
              )}
            </div>
            {offer.notes && <p className="text-sm mt-2 whitespace-pre-wrap" style={{ color: "var(--muted)" }}>{offer.notes}</p>}

            {app.stage !== "hired" && offer.status !== "declined" && (
              <form action={hireApplicantAction} className="mt-4 pt-3 flex items-center gap-3 flex-wrap" style={{ borderTop: "1px solid var(--border)" }}>
                <input type="hidden" name="applicationId" value={appId} />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="fillOpening" /> Mark opening as filled</label>
                <button className="btn btn-sm btn-primary" type="submit">Hire → create employee record</button>
              </form>
            )}
            {app.stage === "hired" && <p className="text-sm mt-3" style={{ color: "var(--ok)" }}>Hired — an employee record was created.</p>}
          </>
        ) : terminal ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>No offer (application is {label(app.stage)}).</p>
        ) : (
          <form action={createOfferAction} className="grid sm:grid-cols-3 gap-2">
            <input type="hidden" name="applicationId" value={appId} />
            <Field label="Salary"><input name="salary" type="number" step="any" defaultValue={app.salaryMin ?? undefined} className="input input-sm" /></Field>
            <Field label="Currency"><select name="currency" defaultValue={app.defaultCurrency ?? ""} className="select select-sm"><option value="">—</option>{currencyOptions(app.defaultCurrency).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
            <Field label="Employment type"><select name="employmentType" defaultValue={app.employmentType} className="select select-sm">{["full_time", "part_time", "fixed_term", "contract", "internship", "consultant"].map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
            <Field label="Start date"><input name="startDate" type="date" className="input input-sm" /></Field>
            <div className="sm:col-span-2"><Field label="Notes"><input name="notes" className="input input-sm" /></Field></div>
            <label className="flex items-center gap-2 text-sm mt-5"><input type="checkbox" name="send" value="1" /> Send to candidate now</label>
            <div className="sm:col-span-3"><button className="btn btn-sm btn-primary" type="submit">Create offer</button></div>
          </form>
        )}
      </div>
    </div>
  );
}
