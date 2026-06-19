import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireStudiesOrg } from "../../_guard";
import { q, one } from "@/server/db";
import { accessibleProjectIds } from "@/server/services/lab";
import { PageHeader, SectionTitle, Field } from "@/components/ui";
import { label } from "@/lib/enums";
import { updateStudyAction } from "@/app/actions";

const TYPES = ["clinical_trial", "cohort", "observational", "other"];
const STATUSES = ["planning", "startup", "recruiting", "active", "follow_up", "closed", "suspended", "terminated"];
const PHASES = ["I", "I/II", "II", "II/III", "III", "IV", "NA"];

export default async function EditStudy({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudiesOrg();
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const s = await one<{
    id: string; code: string | null; title: string; studyType: string; phase: string | null; design: string | null; blinding: string | null; randomized: boolean; allocationRatio: string | null;
    registry: string | null; registrationNumber: string | null; sponsor: string | null; funder: string | null; piId: string | null; piName: string | null; targetEnrollment: number | null; status: string;
    startDate: string | null; endDate: string | null; objectives: string | null; summary: string | null; projectId: string; projectCode: string | null; projectTitle: string | null;
  }>(
    `SELECT s.id, s.code, s.title, s.study_type AS "studyType", s.phase, s.design, s.blinding, s.randomized, s.allocation_ratio AS "allocationRatio",
            s.registry, s.registration_number AS "registrationNumber", s.sponsor, s.funder, s.pi_id AS "piId", s.pi_name AS "piName", s.target_enrollment AS "targetEnrollment", s.status,
            s.start_date::text AS "startDate", s.end_date::text AS "endDate", s.objectives, s.summary, s.project_id AS "projectId", p.code AS "projectCode", p.title AS "projectTitle"
     FROM study s LEFT JOIN project p ON p.id=s.project_id WHERE s.id=$1 AND s.org_id=$2`, [id, orgId]
  );
  if (!s) notFound();
  if (!isAdmin) { const ids = await accessibleProjectIds(userId, orgId, false); if (!ids.includes(s.projectId)) redirect("/studies"); }
  const users = await q<{ id: string; name: string }>(`SELECT u.id, u.name FROM app_user u JOIN org_membership m ON m.user_id=u.id WHERE m.org_id=$1 ORDER BY u.name`, [orgId]);

  return (
    <div className="max-w-3xl">
      <PageHeader title={`Edit ${s.code ?? s.title}`} subtitle={`Under ${s.projectCode ?? "project"}`} actions={<Link href={`/studies/${s.id}`} className="btn btn-sm">← Back</Link>} />

      <form action={updateStudyAction} className="space-y-5">
        <input type="hidden" name="studyId" value={s.id} />
        <div className="card p-4">
          <SectionTitle>Identity</SectionTitle>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Project"><input className="input" value={`${s.projectCode ?? ""} — ${s.projectTitle ?? ""}`} disabled /></Field>
            <Field label="Study code / acronym"><input name="code" defaultValue={s.code ?? ""} className="input" /></Field>
            <div className="sm:col-span-2"><Field label="Title"><input name="title" required defaultValue={s.title} className="input" /></Field></div>
            <Field label="Type"><select name="studyType" defaultValue={s.studyType} className="select">{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
            <Field label="Status"><select name="status" defaultValue={s.status} className="select">{STATUSES.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select></Field>
          </div>
        </div>

        <div className="card p-4">
          <SectionTitle>Design</SectionTitle>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Phase"><select name="phase" defaultValue={s.phase ?? "NA"} className="select">{PHASES.map((p) => <option key={p} value={p}>{p === "NA" ? "N/A" : `Phase ${p}`}</option>)}</select></Field>
            <Field label="Blinding"><select name="blinding" defaultValue={s.blinding ?? "NA"} className="select"><option value="NA">N/A</option><option value="open">Open-label</option><option value="single">Single-blind</option><option value="double">Double-blind</option></select></Field>
            <Field label="Allocation ratio"><input name="allocationRatio" defaultValue={s.allocationRatio ?? ""} className="input" /></Field>
            <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" name="randomized" defaultChecked={s.randomized} /> Randomized</label>
            <div className="sm:col-span-2"><Field label="Design (free text)"><input name="design" defaultValue={s.design ?? ""} className="input" /></Field></div>
          </div>
        </div>

        <div className="card p-4">
          <SectionTitle>Registration & people</SectionTitle>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Registry"><select name="registry" defaultValue={s.registry ?? ""} className="select"><option value="">—</option><option value="ClinicalTrials.gov">ClinicalTrials.gov</option><option value="PACTR">PACTR</option><option value="ISRCTN">ISRCTN</option><option value="other">Other</option></select></Field>
            <Field label="Registration number"><input name="registrationNumber" defaultValue={s.registrationNumber ?? ""} className="input" /></Field>
            <Field label="Sponsor"><input name="sponsor" defaultValue={s.sponsor ?? ""} className="input" /></Field>
            <Field label="Funder"><input name="funder" defaultValue={s.funder ?? ""} className="input" /></Field>
            <Field label="Principal investigator"><select name="piId" defaultValue={s.piId ?? ""} className="select"><option value="">— select —</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
            <Field label="…or PI name (external)"><input name="piName" defaultValue={s.piId ? "" : (s.piName ?? "")} className="input" placeholder="If not a system user" /></Field>
          </div>
        </div>

        <div className="card p-4">
          <SectionTitle>Targets & period</SectionTitle>
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Target enrollment"><input type="number" min={0} name="targetEnrollment" defaultValue={s.targetEnrollment ?? ""} className="input" /></Field>
            <Field label="Start date"><input type="date" name="startDate" defaultValue={s.startDate ?? ""} className="input" /></Field>
            <Field label="End date"><input type="date" name="endDate" defaultValue={s.endDate ?? ""} className="input" /></Field>
          </div>
          <div className="mt-3 grid gap-3">
            <Field label="Objectives"><textarea name="objectives" rows={2} defaultValue={s.objectives ?? ""} className="textarea" /></Field>
            <Field label="Summary"><textarea name="summary" rows={2} defaultValue={s.summary ?? ""} className="textarea" /></Field>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" type="submit">Save changes</button>
          <Link href={`/studies/${s.id}`} className="btn">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
