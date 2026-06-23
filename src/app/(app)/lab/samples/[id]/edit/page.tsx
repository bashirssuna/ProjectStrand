import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireLabOrg } from "../../../_guard";
import { q, one } from "@/server/db";
import { ensureSampleTypes, accessibleProjectIds } from "@/server/services/lab";
import { PageHeader, SectionTitle, Field } from "@/components/ui";
import { editSampleAction } from "@/app/actions";

const CONDITIONS = ["intact", "hemolyzed", "clotted", "lipemic", "icteric", "other"];
const TEMPS = ["4°C", "-20°C", "-80°C", "LN2", "Room Temp"];

export default async function EditSample({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  await ensureSampleTypes(orgId);
  const isAdmin = isOrgAdmin || isSuperAdmin;

  const s = await one<{
    id: string; code: string; projectId: string; projectCode: string | null; status: string; sampleTypeId: string | null; participantId: string | null;
    collectionDate: string | null; collectionTime: string | null; dateAliquoted: string | null; numberOfAliquots: number; aliquotVolume: number | null; aliquotUnit: string;
    condition: string | null; abnormalities: string | null; comments: string | null;
    room: string | null; equipment: string | null; rack: string | null; shelf: string | null; box: string | null; position: string | null; dateStored: string | null; storageTemp: string | null;
    facility: string | null; district: string | null; site: string | null; visitLabel: string | null; freezerId: string | null;
    studyId: string | null; pName: string | null; dob: string | null; pSex: string | null;
  }>(
    `SELECT s.id, s.sample_code AS code, s.project_id AS "projectId", p.code AS "projectCode", s.status, s.sample_type_id AS "sampleTypeId", s.participant_id AS "participantId",
            s.collection_date::text AS "collectionDate", s.collection_time AS "collectionTime", s.date_aliquoted::text AS "dateAliquoted", s.number_of_aliquots AS "numberOfAliquots",
            s.aliquot_volume AS "aliquotVolume", s.aliquot_unit AS "aliquotUnit", s.condition_on_receipt AS condition, s.abnormalities, s.comments,
            s.storage_room AS room, s.storage_equipment AS equipment, s.storage_rack AS rack, s.storage_shelf AS shelf, s.storage_box AS box, s.storage_position AS position,
            s.date_stored::text AS "dateStored", s.storage_temp AS "storageTemp",
            s.collection_facility AS facility, s.collection_district AS district, s.collection_site AS site, v.label AS "visitLabel", s.freezer_id AS "freezerId",
            pa.study_id AS "studyId", pa.name AS "pName", pa.date_of_birth::text AS dob, pa.sex AS "pSex"
     FROM lab_sample s LEFT JOIN lab_participant pa ON pa.id=s.participant_id LEFT JOIN lab_visit v ON v.id=s.visit_id LEFT JOIN project p ON p.id=s.project_id
     WHERE s.id=$1 AND s.org_id=$2`, [id, orgId]
  );
  if (!s) notFound();
  if (!isAdmin) { const ids = await accessibleProjectIds(userId, orgId, false); if (!ids.includes(s.projectId)) redirect("/lab/samples"); }
  if (s.status === "disposed") redirect(`/lab/samples/${id}?err=disposed`);

  const types = await q<{ id: string; category: string; type: string }>(`SELECT id, category, type FROM lab_sample_type WHERE org_id=$1 ORDER BY category, type`, [orgId]);
  const freezers = await q<{ id: string; name: string; location: string | null }>(`SELECT id, name, location FROM lab_freezer WHERE org_id=$1 AND status='active' ORDER BY name`, [orgId]);
  const canStatus = s.status === "active" || s.status === "quarantined";

  return (
    <div className="max-w-3xl">
      <PageHeader title={`Edit ${s.code}`} subtitle={`${s.projectCode ?? ""} · changes are recorded in the sample's history`} actions={<Link href={`/lab/samples/${s.id}`} className="btn btn-sm">← Back</Link>} />

      <form action={editSampleAction} className="space-y-5">
        <input type="hidden" name="sampleId" value={s.id} />

        {s.participantId && (
          <div className="card p-4">
            <SectionTitle>Participant</SectionTitle>
            <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Study ID <span className="font-mono">{s.studyId}</span> can&apos;t be changed here. Editing these updates the participant record (shared by all their samples). Age is recalculated from the date of birth.</p>
            <div className="grid sm:grid-cols-3 gap-3">
              <Field label="Name"><input name="participantName" defaultValue={s.pName ?? ""} className="input" /></Field>
              <Field label="Date of birth"><input type="date" name="participantDob" defaultValue={s.dob ?? ""} className="input" /></Field>
              <Field label="Sex"><select name="participantSex" defaultValue={s.pSex ?? ""} className="select"><option value="">—</option><option value="F">Female</option><option value="M">Male</option><option value="other">Other</option></select></Field>
            </div>
            <div className="grid sm:grid-cols-2 gap-3 mt-3">
              <Field label="Visit / timepoint"><input name="visitLabel" defaultValue={s.visitLabel ?? ""} className="input" placeholder="e.g. Day 0, Visit 1" /></Field>
              <Field label="Visit date"><input type="date" name="visitDate" className="input" /></Field>
            </div>
            <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Change or clear the visit label to re-file this sample under a different timepoint.</p>
          </div>
        )}

        {/* Collection origin (multisite) */}
        <div className="card p-4">
          <SectionTitle>Collection origin</SectionTitle>
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Facility"><input name="collectionFacility" defaultValue={s.facility ?? ""} className="input" placeholder="e.g. Kawempe HC IV" /></Field>
            <Field label="District"><input name="collectionDistrict" defaultValue={s.district ?? ""} className="input" placeholder="e.g. Wakiso" /></Field>
            <Field label="Site / study site"><input name="collectionSite" defaultValue={s.site ?? ""} className="input" placeholder="e.g. Site 03" /></Field>
          </div>
        </div>

        <div className="card p-4">
          <SectionTitle>Sample details</SectionTitle>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Sample type"><select name="sampleTypeId" defaultValue={s.sampleTypeId ?? ""} className="select"><option value="">— choose —</option>{types.map((t) => <option key={t.id} value={t.id}>{t.category} · {t.type}</option>)}</select></Field>
            <Field label="…or new sample type"><input name="newSampleType" className="input" placeholder="Type to add a new type" /></Field>
            <Field label="Condition on receipt"><select name="condition" defaultValue={s.condition ?? "intact"} className="select">{CONDITIONS.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}</select></Field>
            {canStatus
              ? <Field label="Status"><select name="status" defaultValue={s.status} className="select"><option value="active">Active</option><option value="quarantined">Quarantined</option></select></Field>
              : <Field label="Status"><input className="input" value={s.status} disabled /></Field>}
            <Field label="Collection date"><input type="date" name="collectionDate" required defaultValue={s.collectionDate ?? ""} className="input" /></Field>
            <Field label="Collection time"><input name="collectionTime" defaultValue={s.collectionTime ?? ""} className="input" placeholder="HH:MM (24h)" /></Field>
          </div>
          <div className="mt-3 grid gap-3">
            <Field label="Abnormalities"><textarea name="abnormalities" rows={2} defaultValue={s.abnormalities ?? ""} className="textarea" /></Field>
            <Field label="Comments"><textarea name="comments" rows={2} defaultValue={s.comments ?? ""} className="textarea" /></Field>
          </div>
        </div>

        <div className="card p-4">
          <SectionTitle>Processing</SectionTitle>
          <div className="grid sm:grid-cols-4 gap-3">
            <Field label="Date aliquoted"><input type="date" name="dateAliquoted" defaultValue={s.dateAliquoted ?? ""} className="input" /></Field>
            <Field label="No. of aliquots"><input type="number" min={0} name="numberOfAliquots" defaultValue={s.numberOfAliquots} className="input" /></Field>
            <Field label="Volume each"><input type="number" step="0.01" name="aliquotVolume" defaultValue={s.aliquotVolume ?? ""} className="input" /></Field>
            <Field label="Unit"><select name="aliquotUnit" defaultValue={s.aliquotUnit} className="select"><option value="µL">µL</option><option value="mL">mL</option></select></Field>
          </div>
          <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Quantity on hand is managed through retrievals and isn&apos;t edited here.</p>
        </div>

        <div className="card p-4">
          <SectionTitle>Storage location</SectionTitle>
          {freezers.length > 0 && (
            <div className="mb-3"><Field label="Registered freezer"><select name="freezerId" defaultValue={s.freezerId ?? ""} className="select"><option value="">— none —</option>{freezers.map((f) => <option key={f.id} value={f.id}>{f.name}{f.location ? ` · ${f.location}` : ""}</option>)}</select></Field></div>
          )}
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Room"><input name="storageRoom" defaultValue={s.room ?? ""} className="input" /></Field>
            <Field label="Freezer / equipment"><input name="storageEquipment" defaultValue={s.equipment ?? ""} className="input" /></Field>
            <Field label="Rack"><input name="storageRack" defaultValue={s.rack ?? ""} className="input" /></Field>
            <Field label="Shelf"><input name="storageShelf" defaultValue={s.shelf ?? ""} className="input" /></Field>
            <Field label="Box"><input name="storageBox" defaultValue={s.box ?? ""} className="input" /></Field>
            <Field label="Position"><input name="storagePosition" defaultValue={s.position ?? ""} className="input" /></Field>
            <Field label="Date stored"><input type="date" name="dateStored" defaultValue={s.dateStored ?? ""} className="input" /></Field>
            <Field label="Storage temperature"><select name="storageTemp" defaultValue={s.storageTemp ?? ""} className="select"><option value="">—</option>{TEMPS.map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button className="btn btn-primary" type="submit">Save changes</button>
          <Link href={`/lab/samples/${s.id}`} className="btn">Cancel</Link>
        </div>
      </form>
    </div>
  );
}
