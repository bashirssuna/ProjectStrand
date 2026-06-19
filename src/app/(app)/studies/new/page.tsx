import Link from "next/link";
import { requireStudiesOrg } from "../_guard";
import { q } from "@/server/db";
import { accessibleProjectIds } from "@/server/services/lab";
import { PageHeader, SectionTitle, Field } from "@/components/ui";
import { createStudyAction } from "@/app/actions";
import { label } from "@/lib/enums";

const TYPES = ["clinical_trial", "cohort", "observational", "other"];
const STATUSES = ["planning", "startup", "recruiting", "active", "follow_up", "closed", "suspended", "terminated"];
const PHASES = ["I", "I/II", "II", "II/III", "III", "IV", "NA"];

export default async function NewStudy({ searchParams }: { searchParams: Promise<{ projectId?: string; err?: string }> }) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireStudiesOrg();
  const sp = await searchParams;
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const projectIds = await accessibleProjectIds(userId, orgId, isAdmin);
  const projects = await q<{ id: string; code: string; title: string }>(
    projectIds.length ? `SELECT id, code, title FROM project WHERE id IN (${projectIds.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY code` : `SELECT id, code, title FROM project WHERE false`, projectIds
  );
  const users = await q<{ id: string; name: string }>(`SELECT u.id, u.name FROM app_user u JOIN org_membership m ON m.user_id=u.id WHERE m.org_id=$1 ORDER BY u.name`, [orgId]);

  if (projects.length === 0) {
    return <div><PageHeader title="New study" /><div className="card p-4 text-sm" style={{ color: "var(--muted)" }}>You don&apos;t have access to any project yet. A study is registered under a project — ask an administrator to add you to one first.</div></div>;
  }

  return (
    <div className="max-w-3xl">
      <PageHeader title="New study" subtitle="Register a clinical trial or cohort" actions={<Link href="/studies" className="btn btn-sm">← Studies</Link>} />
      {sp.err === "project" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Choose a project you have access to.</div>}

      <form action={createStudyAction} className="space-y-5">
        <div className="card p-4">
          <SectionTitle>Identity</SectionTitle>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Project"><select name="projectId" required defaultValue={sp.projectId ?? (projects[0]?.id ?? "")} className="select">{projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}</select></Field>
            <Field label="Study code / acronym"><input name="code" className="input" placeholder="e.g. SHISTO-VAC" /></Field>
            <div className="sm:col-span-2"><Field label="Title"><input name="title" required className="input" placeholder="Full study title" /></Field></div>
            <Field label="Type"><select name="studyType" defaultValue="clinical_trial" className="select">{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
            <Field label="Status"><select name="status" defaultValue="planning" className="select">{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
          </div>
        </div>

        <div className="card p-4">
          <SectionTitle>Design</SectionTitle>
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Phase, blinding and randomization apply to interventional trials — leave them as-is for cohorts.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Phase"><select name="phase" defaultValue="NA" className="select">{PHASES.map((p) => <option key={p} value={p}>{p === "NA" ? "N/A" : `Phase ${p}`}</option>)}</select></Field>
            <Field label="Blinding"><select name="blinding" defaultValue="NA" className="select"><option value="NA">N/A</option><option value="open">Open-label</option><option value="single">Single-blind</option><option value="double">Double-blind</option></select></Field>
            <Field label="Allocation ratio"><input name="allocationRatio" className="input" placeholder="e.g. 1:1" /></Field>
            <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" name="randomized" /> Randomized</label>
            <div className="sm:col-span-2"><Field label="Design (free text)"><input name="design" className="input" placeholder="e.g. Prospective open cohort; or randomized double-blind placebo-controlled" /></Field></div>
          </div>
        </div>

        <div className="card p-4">
          <SectionTitle>Registration & people</SectionTitle>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Registry"><select name="registry" defaultValue="" className="select"><option value="">—</option><option value="ClinicalTrials.gov">ClinicalTrials.gov</option><option value="PACTR">PACTR</option><option value="ISRCTN">ISRCTN</option><option value="other">Other</option></select></Field>
            <Field label="Registration number"><input name="registrationNumber" className="input" placeholder="e.g. NCT… / PACTR…" /></Field>
            <Field label="Sponsor"><input name="sponsor" className="input" /></Field>
            <Field label="Funder"><input name="funder" className="input" /></Field>
            <Field label="Principal investigator"><select name="piId" defaultValue="" className="select"><option value="">— select —</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
            <Field label="…or PI name (external)"><input name="piName" className="input" placeholder="If not a system user" /></Field>
          </div>
        </div>

        <div className="card p-4">
          <SectionTitle>Targets & period</SectionTitle>
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Target enrollment"><input type="number" min={0} name="targetEnrollment" className="input" /></Field>
            <Field label="Start date"><input type="date" name="startDate" className="input" /></Field>
            <Field label="End date"><input type="date" name="endDate" className="input" /></Field>
          </div>
          <div className="mt-3 grid gap-3">
            <Field label="Objectives"><textarea name="objectives" rows={2} className="textarea" /></Field>
            <Field label="Summary"><textarea name="summary" rows={2} className="textarea" /></Field>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" type="submit">Create study</button>
          <Link href="/studies" className="btn">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
