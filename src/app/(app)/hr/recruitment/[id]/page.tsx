import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHrOrg } from "../../_guard";
import { getOpening, listApplications, openingStats, STAGES } from "@/server/services/recruitment";
import { PageHeader, SectionTitle, Field, StatusBadge, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { addCandidateApplicationAction, setOpeningStatusAction } from "@/app/actions";

const OPENING_STATUSES = ["draft", "open", "on_hold", "closed", "filled", "cancelled"];
const SOURCES = ["advert", "referral", "headhunt", "walk_in", "direct"];
const PIPELINE = [...STAGES, "rejected", "withdrawn"];

export default async function OpeningDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ added?: string; saved?: string; err?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const { id } = await params;
  const sp = await searchParams;
  const opening = await getOpening(orgId, id);
  if (!opening) notFound();
  const apps = await listApplications(orgId, id);
  const byStage = (s: string) => apps.filter((a) => a.stage === s);
  const salary = opening.salaryMin || opening.salaryMax
    ? `${money(opening.salaryMin ?? 0, opening.currency ?? "USD")}${opening.salaryMax ? ` – ${money(opening.salaryMax, opening.currency ?? "USD")}` : ""}`
    : null;

  return (
    <div className="max-w-5xl">
      <PageHeader title={opening.title} subtitle={`${label(opening.employmentType)}${opening.department ? ` · ${opening.department}` : ""}${opening.location ? ` · ${opening.location}` : ""}`} actions={<Link href="/hr/recruitment" className="btn btn-sm">← Openings</Link>} />
      {sp.added && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Candidate added to the pipeline.</div>}
      {sp.err === "cand" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Candidate name is required.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-5">
        <StatusBadge status={opening.status} />
        {opening.reference && <span className="text-xs font-mono" style={{ color: "var(--muted)" }}>{opening.reference}</span>}
        <span className="text-sm" style={{ color: "var(--muted)" }}>{opening.positions} position{opening.positions === 1 ? "" : "s"}</span>
        {salary && <span className="text-sm tabular-nums" style={{ color: "var(--muted)" }}>{salary}</span>}
        {opening.closingDate && <span className="text-sm" style={{ color: "var(--muted)" }}>Closes {fmtDate(opening.closingDate)}</span>}
        <form action={setOpeningStatusAction} className="ml-auto flex items-center gap-2">
          <input type="hidden" name="openingId" value={opening.id} />
          <select name="status" defaultValue={opening.status} className="select select-sm">{OPENING_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
          <button className="btn btn-sm" type="submit">Set status</button>
        </form>
      </div>

      {(opening.description || opening.responsibilities || opening.requirements) && (
        <div className="card p-4 mb-5 space-y-3">
          {opening.description && <div><div className="label">Role summary</div><p className="text-sm whitespace-pre-wrap">{opening.description}</p></div>}
          {opening.responsibilities && <div><div className="label">Responsibilities</div><p className="text-sm whitespace-pre-wrap">{opening.responsibilities}</p></div>}
          {opening.requirements && <div><div className="label">Requirements</div><p className="text-sm whitespace-pre-wrap">{opening.requirements}</p></div>}
        </div>
      )}

      <SectionTitle>Candidate pipeline ({apps.length})</SectionTitle>
      {apps.length === 0 ? (
        <Empty title="No candidates yet" hint="Add the first candidate below." />
      ) : (
        <div className="space-y-4 mt-2 mb-6">
          {PIPELINE.map((stage) => {
            const list = byStage(stage);
            if (list.length === 0) return null;
            return (
              <div key={stage} className="card overflow-hidden">
                <div className="px-4 py-2 flex items-center gap-2" style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
                  <span className="text-sm font-medium">{label(stage)}</span><Badge tone={stage === "rejected" || stage === "withdrawn" ? "muted" : stage === "hired" ? "ok" : "info"}>{list.length}</Badge>
                </div>
                <table className="w-full text-sm">
                  <tbody>
                    {list.map((a) => (
                      <tr key={a.id}>
                        <td className="td"><Link href={`/hr/recruitment/application/${a.id}`} className="font-medium hover:underline">{a.fullName}</Link>{a.currentTitle && <span className="text-xs" style={{ color: "var(--muted)" }}> · {a.currentTitle}</span>}</td>
                        <td className="td">{a.source ? label(a.source) : ""}</td>
                        <td className="td text-right whitespace-nowrap">{a.interviews > 0 ? `${a.interviews} interview${a.interviews === 1 ? "" : "s"}` : ""}</td>
                        <td className="td text-right tabular-nums">{a.avgScore != null ? `${a.avgScore}/5` : ""}</td>
                        <td className="td text-right">{a.cvKey && <a href={`/api/candidate-cv/${a.candidateId}`} className="text-xs hover:underline" style={{ color: "var(--brand)" }}>CV</a>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          })}
        </div>
      )}

      <div className="card p-4">
        <SectionTitle>Add candidate</SectionTitle>
        <form action={addCandidateApplicationAction} className="grid sm:grid-cols-2 gap-3 mt-2">
          <input type="hidden" name="openingId" value={opening.id} />
          <Field label="Full name *"><input name="fullName" required className="input" /></Field>
          <Field label="Email"><input name="email" type="email" className="input" /></Field>
          <Field label="Phone"><input name="phone" className="input" /></Field>
          <Field label="Source"><select name="source" className="select"><option value="">—</option>{SOURCES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
          <Field label="Current title"><input name="currentTitle" className="input" /></Field>
          <Field label="Current employer"><input name="currentEmployer" className="input" /></Field>
          <Field label="Highest qualification"><input name="highestQualification" className="input" /></Field>
          <Field label="Years of experience"><input name="yearsExperience" type="number" step="any" className="input" /></Field>
          <Field label="Gender"><select name="gender" className="select"><option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></Field>
          <Field label="Location"><input name="location" className="input" /></Field>
          <Field label="CV / résumé"><input name="cv" type="file" accept=".pdf,.doc,.docx" className="input" /></Field>
          <div className="sm:col-span-2"><Field label="Cover note"><textarea name="coverNote" rows={2} className="input" /></Field></div>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Add to pipeline</button></div>
        </form>
      </div>
    </div>
  );
}
