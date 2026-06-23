import Link from "next/link";
import { requireLabOrg } from "../../_guard";
import { q } from "@/server/db";
import { ensureSampleTypes, accessibleProjectIds, canSeePII } from "@/server/services/lab";
import { canCreateProjects } from "@/server/policy";
import { PageHeader, SectionTitle, Field } from "@/components/ui";
import { createSampleAction } from "@/app/actions";

const CONDITIONS = ["intact", "hemolyzed", "clotted", "lipemic", "icteric", "other"];
const TEMPS = ["4°C", "-20°C", "-80°C", "LN2", "Room Temp"];

export default async function RegisterSample({ searchParams }: { searchParams: Promise<{ projectId?: string; created?: string; err?: string }> }) {
  const { orgId, userId, userName, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  await ensureSampleTypes(orgId);
  const sp = await searchParams;
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const projectIds = await accessibleProjectIds(userId, orgId, isAdmin);
  const projects = await q<{ id: string; code: string; title: string }>(
    projectIds.length ? `SELECT id, code, title FROM project WHERE id IN (${projectIds.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY code` : `SELECT id, code, title FROM project WHERE false`, projectIds
  );
  const types = await q<{ id: string; category: string; type: string }>(`SELECT id, category, type FROM lab_sample_type WHERE org_id=$1 ORDER BY category, type`, [orgId]);
  const freezers = await q<{ id: string; name: string; location: string | null }>(`SELECT id, name, location FROM lab_freezer WHERE org_id=$1 AND status='active' ORDER BY name`, [orgId]);
  const seePII = canSeePII(isOrgAdmin, isSuperAdmin);
  const canCreate = await canCreateProjects(userId, isSuperAdmin);

  if (projects.length === 0 && !canCreate) {
    return <div><PageHeader title="Register sample" /><div className="card p-4 text-sm" style={{ color: "var(--muted)" }}>You don&apos;t have access to any project yet, and your role can&apos;t create one. Ask an administrator to add you to a project before registering samples.</div></div>;
  }
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-3xl">
      <PageHeader title="Register sample" subtitle="Add a biospecimen to the registry" actions={<Link href="/lab/samples" className="btn btn-sm">← Registry</Link>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Sample {decodeURIComponent(sp.created)} registered. Add another below.</div>}
      {sp.err === "project" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Choose an existing project or enter a new project name.</div>}
      {sp.err === "projectperm" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Your role can&apos;t create new projects. Select an existing project instead.</div>}

      <form action={createSampleAction} className="space-y-5">
        {/* Participant */}
        <div className="card p-4">
          <SectionTitle>Participant</SectionTitle>
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Enter the Study ID. If it&apos;s new, fill the details to create the participant; if it already exists, the existing record is reused and the age is taken from their date of birth.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Study ID"><input name="studyId" className="input" placeholder="e.g. SH-0412" /></Field>
            <Field label={`Name${seePII ? "" : " (kept confidential)"}`}><input name="participantName" className="input" placeholder="Full name" /></Field>
            <Field label="Date of birth"><input type="date" name="participantDob" className="input" /></Field>
            <Field label="Sex"><select name="participantSex" className="select"><option value="">—</option><option value="F">Female</option><option value="M">Male</option><option value="other">Other</option></select></Field>
          </div>
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <Field label="Visit / timepoint"><input name="visitLabel" className="input" placeholder="e.g. Day 0, Visit 1 — for repeat sampling" /></Field>
            <Field label="Visit date"><input type="date" name="visitDate" className="input" /></Field>
          </div>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Give a visit label to group this participant&apos;s samples by timepoint. The visit is created on first use and reused for later samples in the same visit.</p>
        </div>

        {/* Collection origin (multisite) */}
        <div className="card p-4">
          <SectionTitle>Collection origin</SectionTitle>
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Where the sample was collected — useful for multisite studies.</p>
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Facility"><input name="collectionFacility" className="input" placeholder="e.g. Kawempe HC IV" /></Field>
            <Field label="District"><input name="collectionDistrict" className="input" placeholder="e.g. Wakiso" /></Field>
            <Field label="Site / study site"><input name="collectionSite" className="input" placeholder="e.g. Site 03" /></Field>
          </div>
        </div>

        {/* Sample details */}
        <div className="card p-4">
          <SectionTitle>Sample details</SectionTitle>
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>The sample ID is generated automatically as <span className="font-mono">PROJECT-{new Date().getFullYear()}-NNNN</span> when you save.</p>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Project (existing)"><select name="projectId" defaultValue={sp.projectId ?? (projects[0]?.id ?? "")} className="select">{projects.length === 0 && <option value="">— none yet —</option>}{projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}</select></Field>
            {canCreate && <Field label="…or new project name"><input name="newProjectName" className="input" placeholder="Type to register under a new project" /></Field>}
          </div>
          {canCreate && <p className="text-xs mt-1 mb-3" style={{ color: "var(--muted)" }}>Enter a new project name to register this sample under a project that doesn&apos;t exist yet — it&apos;s created and used instead of the selection above.</p>}
          <div className="grid sm:grid-cols-2 gap-3 mt-3">
            <Field label="Sample type"><select name="sampleTypeId" className="select"><option value="">— choose —</option>{types.map((t) => <option key={t.id} value={t.id}>{t.category} · {t.type}</option>)}</select></Field>
            <Field label="…or new sample type"><input name="newSampleType" className="input" placeholder="e.g. Semen, Sputum, Swab…" /></Field>
            <Field label="Condition on receipt"><select name="condition" className="select">{CONDITIONS.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</select></Field>
            <Field label="Collection date"><input type="date" name="collectionDate" required defaultValue={today} className="input" /></Field>
            <Field label="Collection time"><input name="collectionTime" className="input" placeholder="HH:MM (24h)" /></Field>
          </div>
          <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Not in the list? Type the sample type above (e.g. Semen) and it&apos;s added to your catalogue for next time.</p>
          <div className="mt-3 grid gap-3">
            <Field label="Abnormalities"><textarea name="abnormalities" rows={2} className="textarea" placeholder="Note any abnormalities (leave blank if none)" /></Field>
            <Field label="Comments"><textarea name="comments" rows={2} className="textarea" /></Field>
          </div>
        </div>

        {/* Processing */}
        <div className="card p-4">
          <SectionTitle>Processing (if aliquoted)</SectionTitle>
          <div className="grid sm:grid-cols-4 gap-3">
            <Field label="Date aliquoted"><input type="date" name="dateAliquoted" className="input" /></Field>
            <Field label="No. of aliquots"><input type="number" min={0} name="numberOfAliquots" defaultValue={0} className="input" /></Field>
            <Field label="Volume each"><input type="number" step="0.01" name="aliquotVolume" className="input" /></Field>
            <Field label="Unit"><select name="aliquotUnit" className="select"><option value="µL">µL</option><option value="mL">mL</option></select></Field>
          </div>
        </div>

        {/* Storage */}
        <div className="card p-4">
          <SectionTitle>Storage location</SectionTitle>
          {freezers.length > 0 && (
            <div className="mb-3">
              <Field label="Registered freezer"><select name="freezerId" className="select"><option value="">— none —</option>{freezers.map((f) => <option key={f.id} value={f.id}>{f.name}{f.location ? ` · ${f.location}` : ""}</option>)}</select></Field>
              <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Linking to a registered freezer means temperature excursions and incidents on that unit will flag this sample.</p>
            </div>
          )}
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Room"><input name="storageRoom" className="input" placeholder="e.g. Cold Room 1" /></Field>
            <Field label="Freezer / equipment"><input name="storageEquipment" className="input" placeholder="e.g. FZR-01" /></Field>
            <Field label="Rack"><input name="storageRack" className="input" placeholder="e.g. Rack-A" /></Field>
            <Field label="Shelf"><input name="storageShelf" className="input" placeholder="e.g. Shelf-3" /></Field>
            <Field label="Box"><input name="storageBox" className="input" placeholder="e.g. BOX-12" /></Field>
            <Field label="Position"><input name="storagePosition" className="input" placeholder="e.g. D4" /></Field>
            <Field label="Date stored"><input type="date" name="dateStored" defaultValue={today} className="input" /></Field>
            <Field label="Storage temperature"><select name="storageTemp" className="select"><option value="">—</option>{TEMPS.map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
            <Field label="Stored by"><input name="storedBy" defaultValue={userName} className="input" disabled /></Field>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" name="another" value="0" type="submit">Save &amp; view</button>
          <button className="btn" name="another" value="1" type="submit">Save &amp; register another</button>
          <Link href="/lab/samples" className="btn">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
