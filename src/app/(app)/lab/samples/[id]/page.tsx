import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireLabOrg } from "../../_guard";
import { q, one } from "@/server/db";
import { accessibleProjectIds, canSeePII, maskName, formatAge } from "@/server/services/lab";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Stat } from "@/components/ui";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { retrieveSampleAction, returnSampleAction, disposeSampleAction, revealParticipantNameAction, updateConsentAction, recordFreezeThawAction } from "@/app/actions";

type SP = { reveal?: string; retrieved?: string; returned?: string; disposed?: string; consent?: string; edited?: string; err?: string; ft?: string };

export default async function SampleDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  const sp = await searchParams;
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const seePII = canSeePII(isOrgAdmin, isSuperAdmin);

  const s = await one<{
    id: string; code: string; projectId: string; projectCode: string | null; status: string;
    participantId: string | null; studyId: string | null; participantName: string | null; sex: string | null; consent: string | null;
    ageYears: number | null; ageMonths: number | null; typeName: string | null; category: string | null;
    collectionDate: string; collectionTime: string | null; dateAliquoted: string | null; numberOfAliquots: number;
    aliquotVolume: number | null; aliquotUnit: string; quantityRemaining: number | null;
    room: string | null; equipment: string | null; rack: string | null; shelf: string | null; box: string | null; position: string | null;
    dateStored: string | null; storageTemp: string | null; storedByName: string | null;
    condition: string | null; abnormalities: string | null; comments: string | null;
    facility: string | null; district: string | null; site: string | null; visitLabel: string | null; visitDate: string | null; freezeThawCount: number; maxFreezeThaw: number | null;
    disposalDate: string | null; disposalMethod: string | null; disposalReason: string | null; disposalWitness: string | null; disposedByName: string | null;
    createdByName: string | null; createdAt: string;
  }>(
    `SELECT s.id, s.sample_code AS code, s.project_id AS "projectId", p.code AS "projectCode", s.status,
            s.participant_id AS "participantId", pa.study_id AS "studyId", pa.name AS "participantName", pa.sex, pa.consent_status AS consent,
            s.age_years AS "ageYears", s.age_months AS "ageMonths", st.type AS "typeName", st.category,
            s.collection_date AS "collectionDate", s.collection_time AS "collectionTime", s.date_aliquoted AS "dateAliquoted",
            s.number_of_aliquots AS "numberOfAliquots", s.aliquot_volume AS "aliquotVolume", s.aliquot_unit AS "aliquotUnit", s.quantity_remaining AS "quantityRemaining",
            s.storage_room AS room, s.storage_equipment AS equipment, s.storage_rack AS rack, s.storage_shelf AS shelf, s.storage_box AS box, s.storage_position AS position,
            s.date_stored AS "dateStored", s.storage_temp AS "storageTemp", s.stored_by_name AS "storedByName",
            s.condition_on_receipt AS condition, s.abnormalities, s.comments,
            s.collection_facility AS facility, s.collection_district AS district, s.collection_site AS site, v.label AS "visitLabel", v.visit_date AS "visitDate", s.freeze_thaw_count AS "freezeThawCount", st.max_freeze_thaw AS "maxFreezeThaw",
            s.disposal_date AS "disposalDate", s.disposal_method AS "disposalMethod", s.disposal_reason AS "disposalReason", s.disposal_witness AS "disposalWitness", s.disposed_by_name AS "disposedByName",
            s.created_by_name AS "createdByName", s.created_at AS "createdAt"
     FROM lab_sample s
     LEFT JOIN lab_participant pa ON pa.id=s.participant_id
     LEFT JOIN lab_sample_type st ON st.id=s.sample_type_id
     LEFT JOIN lab_visit v ON v.id=s.visit_id
     LEFT JOIN project p ON p.id=s.project_id
     WHERE s.id=$1 AND s.org_id=$2`, [id, orgId]
  );
  if (!s) notFound();
  // Non-admins may only see samples in projects they belong to.
  if (!isAdmin) { const ids = await accessibleProjectIds(userId, orgId, false); if (!ids.includes(s.projectId)) redirect("/lab/samples"); }

  const retrievals = await q<{ id: string; dateRetrieved: string; quantityRemoved: number | null; quantityRemaining: number | null; purpose: string | null; destination: string | null; retrievedByName: string | null; authorizedByName: string | null; returnedDate: string | null; returnedToShelf: string | null }>(
    `SELECT id, date_retrieved AS "dateRetrieved", quantity_removed AS "quantityRemoved", quantity_remaining AS "quantityRemaining", purpose, destination, retrieved_by_name AS "retrievedByName", authorized_by_name AS "authorizedByName", returned_date AS "returnedDate", returned_to_shelf AS "returnedToShelf" FROM lab_retrieval WHERE sample_id=$1 ORDER BY date_retrieved ASC`, [id]
  );

  // Change history (audit trail) for this sample record.
  const history = await q<{ action: string; actor: string | null; createdAt: string; before: string | null; after: string | null; meta: string | null }>(
    `SELECT a.action, a.created_at AS "createdAt", a.before, a.after, a.meta, u.name AS actor
     FROM audit_log a LEFT JOIN app_user u ON u.id=a.user_id
     WHERE a.entity='lab_sample' AND a.entity_id=$1 ORDER BY a.created_at DESC`, [s.code]
  );
  const parse = (j: string | null): Record<string, unknown> | null => { if (!j) return null; try { const v = JSON.parse(j); return v && typeof v === "object" ? v as Record<string, unknown> : null; } catch { return null; } };
  const histRows = history.map((h) => {
    const before = parse(h.before), after = parse(h.after), meta = parse(h.meta);
    let title = "Updated";
    if (h.action === "create") title = "Registered";
    else if (meta && "fields" in meta) title = "Edited";
    else if (after && "retrieved" in after) title = "Retrieved";
    else if (after && "returned" in after) title = "Returned to storage";
    else if (after && after["status"] === "disposed") title = "Disposed";
    const isEdit = title === "Edited" && before && after;
    return { title, actor: h.actor, createdAt: h.createdAt, before, after, isEdit };
  });

  const revealed = seePII && sp.reveal === "1";
  const nameDisplay = revealed ? (s.participantName ?? "—") : maskName(s.participantName, false);
  const storagePath = [s.room, s.equipment, s.rack, s.shelf, s.box, s.position].filter(Boolean).join(" / ") || "Not stored";
  const isOut = retrievals.some((r) => !r.returnedDate);
  const disposed = s.status === "disposed";

  // Chain of custody (oldest first)
  type Ev = { when: string; title: string; who: string | null; detail: string };
  const events: Ev[] = [];
  events.push({ when: s.createdAt, title: "Registered", who: s.createdByName, detail: s.code });
  if (s.dateStored) events.push({ when: s.dateStored, title: "Stored", who: s.storedByName, detail: storagePath });
  for (const r of retrievals) {
    events.push({ when: r.dateRetrieved, title: "Retrieved", who: r.retrievedByName, detail: `${r.quantityRemoved != null ? `${r.quantityRemoved} ${s.aliquotUnit} removed, ` : ""}${r.quantityRemaining != null ? `${r.quantityRemaining} ${s.aliquotUnit} remaining` : ""}${r.purpose ? ` · ${r.purpose}` : ""}${r.destination ? ` → ${r.destination}` : ""}${r.authorizedByName ? ` (auth: ${r.authorizedByName})` : ""}` });
    if (r.returnedDate) events.push({ when: r.returnedDate, title: "Returned", who: null, detail: r.returnedToShelf ? `to ${r.returnedToShelf}` : "to storage" });
  }
  if (disposed && s.disposalDate) events.push({ when: s.disposalDate, title: "Disposed", who: s.disposedByName, detail: `${s.disposalReason ?? ""}${s.disposalWitness ? ` · witness ${s.disposalWitness}` : ""}` });
  events.sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime());

  return (
    <div className="max-w-5xl">
      <PageHeader title={s.code} subtitle={`${s.typeName ?? "Sample"}${s.projectCode ? ` · ${s.projectCode}` : ""}`} actions={<div className="flex gap-2">{!disposed && <Link href={`/lab/samples/${s.id}/edit`} className="btn btn-sm">Edit</Link>}<Link href="/lab/samples" className="btn btn-sm">← Registry</Link></div>} />
      {sp.edited && (sp.edited === "0" ? <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>No changes to save.</div> : <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved {sp.edited} change{sp.edited === "1" ? "" : "s"} — recorded in the history below.</div>)}
      {sp.retrieved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Retrieval logged.</div>}
      {sp.ft && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Freeze-thaw cycle recorded.</div>}
      {sp.returned && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Return to storage recorded.</div>}
      {sp.disposed && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Sample disposed.</div>}
      {sp.consent && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Consent status updated.</div>}
      {sp.err === "consent" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Consent has been withdrawn for this participant — retrieval is blocked. Flag the sample for disposal.</div>}
      {sp.err === "disposed" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>This sample is disposed.</div>}
      {sp.err === "forbidden" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>You are not authorised for that action.</div>}
      {sp.err === "reason" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A disposal reason is required.</div>}

      <div className="grid lg:grid-cols-3 gap-5">
        {/* Left: details */}
        <div className="lg:col-span-2 space-y-5">
          <div className="card p-4">
            <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
              <StatusBadge status={s.status} />
              {s.consent && s.consent !== "valid" && <Badge tone="danger">consent {s.consent}</Badge>}
              {isOut && !disposed && <Badge tone="warn">currently out</Badge>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Stat label="Quantity on hand" value={s.quantityRemaining != null ? `${s.quantityRemaining} ${s.aliquotUnit}` : "—"} />
              <Stat label="Aliquots" value={String(s.numberOfAliquots)} />
              <Stat label="Age at collection" value={formatAge(s.ageYears, s.ageMonths)} />
              <Stat label="Collected" value={fmtDate(s.collectionDate)} sub={s.collectionTime ?? undefined} />
              <Stat label="Freeze-thaw" value={s.maxFreezeThaw != null ? `${s.freezeThawCount} / ${s.maxFreezeThaw}` : String(s.freezeThawCount)} tone={s.maxFreezeThaw != null && s.freezeThawCount >= s.maxFreezeThaw ? "danger" : undefined} />
            </div>
          </div>

          <div className="card p-4">
            <SectionTitle>Participant</SectionTitle>
            <div className="grid sm:grid-cols-2 gap-y-2 text-sm">
              <div><span style={{ color: "var(--muted)" }}>Study ID: </span>{s.studyId ?? "—"}</div>
              <div className="flex items-center gap-2">
                <span style={{ color: "var(--muted)" }}>Name: </span><span>{nameDisplay}</span>
                {s.participantId && seePII && !revealed && (
                  <form action={revealParticipantNameAction} className="inline"><input type="hidden" name="sampleId" value={s.id} /><input type="hidden" name="participantId" value={s.participantId} /><button className="btn btn-sm" type="submit">Reveal</button></form>
                )}
                {revealed && <Badge tone="info">access logged</Badge>}
              </div>
              <div><span style={{ color: "var(--muted)" }}>Sex: </span>{s.sex ?? "—"}</div>
              <div><span style={{ color: "var(--muted)" }}>Consent: </span>{s.consent ? label(s.consent) : "—"}</div>
              {s.visitLabel && <div><span style={{ color: "var(--muted)" }}>Visit: </span>{s.visitLabel}{s.visitDate ? ` · ${fmtDate(s.visitDate)}` : ""}</div>}
            </div>
            {!seePII && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>The participant&apos;s name is confidential for your role.</p>}
          </div>

          <div className="card p-4">
            <SectionTitle>Sample &amp; storage</SectionTitle>
            <div className="grid sm:grid-cols-2 gap-y-2 text-sm">
              <div><span style={{ color: "var(--muted)" }}>Type: </span>{s.category ? `${s.category} · ` : ""}{s.typeName ?? "—"}</div>
              <div><span style={{ color: "var(--muted)" }}>Condition: </span>{s.condition ? label(s.condition) : "—"}</div>
              <div><span style={{ color: "var(--muted)" }}>Aliquoted: </span>{s.dateAliquoted ? `${fmtDate(s.dateAliquoted)} · ${s.numberOfAliquots} × ${s.aliquotVolume ?? "?"} ${s.aliquotUnit}` : "—"}</div>
              <div><span style={{ color: "var(--muted)" }}>Temperature: </span>{s.storageTemp ?? "—"}</div>
              <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Location: </span><span className="font-mono text-xs">{storagePath}</span>{s.dateStored ? <span style={{ color: "var(--muted)" }}> · stored {fmtDate(s.dateStored)}</span> : ""}</div>
              {(s.facility || s.district || s.site) && <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Collection origin: </span>{[s.facility, s.district, s.site].filter(Boolean).join(" · ")}</div>}
              {s.abnormalities && <div className="sm:col-span-2"><span style={{ color: "var(--warn)" }}>Abnormalities: </span>{s.abnormalities}</div>}
              {s.comments && <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Comments: </span>{s.comments}</div>}
            </div>
          </div>

          {/* Actions */}
          {!disposed && (
            <div className="card p-4">
              <SectionTitle>Actions</SectionTitle>
              <div className="grid md:grid-cols-2 gap-4">
                {/* Retrieve */}
                <form action={retrieveSampleAction} className="border rounded-lg p-3" style={{ borderColor: "var(--border)" }}>
                  <input type="hidden" name="sampleId" value={s.id} />
                  <div className="font-medium text-sm mb-2">Retrieve material</div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label={`Quantity removed (${s.aliquotUnit})`}><input type="number" step="0.01" name="quantityRemoved" className="input" /></Field>
                    <Field label="Purpose"><input name="purpose" className="input" placeholder="e.g. PCR assay" /></Field>
                    <Field label="Destination"><input name="destination" className="input" placeholder="e.g. Bench 2" /></Field>
                    <Field label="Authorised by"><input name="authorizedByName" className="input" placeholder="Manager name" /></Field>
                  </div>
                  <label className="flex items-center gap-2 text-xs mt-2" style={{ color: "var(--muted)" }}><input type="checkbox" name="thawed" value="1" /> Sample was thawed (counts as a freeze-thaw cycle)</label>
                  <button className="btn btn-sm btn-primary mt-2" type="submit">Log retrieval</button>
                </form>

                {/* Record a freeze-thaw cycle without removing material */}
                <form action={recordFreezeThawAction} className="border rounded-lg p-3" style={{ borderColor: "var(--border)" }}>
                  <input type="hidden" name="sampleId" value={s.id} />
                  <div className="font-medium text-sm mb-2">Record freeze-thaw</div>
                  <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Use when the sample was thawed in place (e.g. for QC) without removing material. Current cycles: {s.freezeThawCount}{s.maxFreezeThaw != null ? ` of ${s.maxFreezeThaw} max` : ""}.{s.maxFreezeThaw != null && s.freezeThawCount >= s.maxFreezeThaw ? " Limit reached." : ""}</p>
                  <button className="btn btn-sm mt-1" type="submit">+1 freeze-thaw cycle</button>
                </form>

                {/* Return */}
                {isOut ? (
                  <form action={returnSampleAction} className="border rounded-lg p-3" style={{ borderColor: "var(--border)" }}>
                    <input type="hidden" name="sampleId" value={s.id} />
                    <div className="font-medium text-sm mb-2">Return to storage</div>
                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Returned to shelf"><input name="returnedToShelf" className="input" defaultValue={s.shelf ?? ""} /></Field>
                      <Field label="Out for (minutes)"><input type="number" name="tempExposureMinutes" className="input" /></Field>
                    </div>
                    <button className="btn btn-sm mt-2" type="submit">Record return</button>
                  </form>
                ) : (
                  <div className="border rounded-lg p-3 text-sm" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>Sample is in storage. Log a retrieval to take material out.</div>
                )}

                {/* Dispose — managers only */}
                {isAdmin && (
                  <form action={disposeSampleAction} className="border rounded-lg p-3 md:col-span-2" style={{ borderColor: "var(--danger)" }}>
                    <input type="hidden" name="sampleId" value={s.id} />
                    <div className="font-medium text-sm mb-2" style={{ color: "var(--danger)" }}>Dispose sample</div>
                    <div className="grid sm:grid-cols-3 gap-2">
                      <Field label="Method"><input name="method" className="input" placeholder="e.g. Autoclave" /></Field>
                      <Field label="Reason (required)"><input name="reason" required className="input" placeholder="e.g. Depleted / consent withdrawn" /></Field>
                      <Field label="Witness"><input name="witness" className="input" placeholder="Witness name" /></Field>
                    </div>
                    <button className="btn btn-sm mt-2" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Dispose sample</button>
                  </form>
                )}

                {/* Consent — managers only */}
                {isAdmin && s.participantId && (
                  <form action={updateConsentAction} className="border rounded-lg p-3 md:col-span-2 flex flex-wrap items-end gap-2" style={{ borderColor: "var(--border)" }}>
                    <input type="hidden" name="sampleId" value={s.id} />
                    <input type="hidden" name="participantId" value={s.participantId} />
                    <Field label="Consent status"><select name="consentStatus" defaultValue={s.consent ?? "valid"} className="select"><option value="valid">Valid</option><option value="expired">Expired</option><option value="withdrawn">Withdrawn</option></select></Field>
                    <button className="btn btn-sm" type="submit">Update consent</button>
                    <span className="text-xs" style={{ color: "var(--muted)" }}>Withdrawing consent blocks further retrieval.</span>
                  </form>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right: chain of custody */}
        <div>
          <SectionTitle>Chain of custody</SectionTitle>
          <div className="card p-4">
            <ol className="space-y-4">
              {events.map((e, i) => (
                <li key={i} className="relative pl-5">
                  <span style={{ position: "absolute", left: 0, top: 4, width: 9, height: 9, borderRadius: "50%", background: e.title === "Disposed" ? "var(--danger)" : e.title === "Retrieved" ? "var(--warn)" : "var(--brand)" }} />
                  {i < events.length - 1 && <span style={{ position: "absolute", left: 4, top: 13, bottom: -16, width: 1, background: "var(--border)" }} />}
                  <div className="text-sm font-medium">{e.title}</div>
                  <div className="text-xs" style={{ color: "var(--muted)" }}>{fmtDateTime(e.when)}{e.who ? ` · ${e.who}` : ""}</div>
                  {e.detail && <div className="text-xs mt-0.5">{e.detail}</div>}
                </li>
              ))}
            </ol>
          </div>
        </div>
      </div>

      {/* Change history (audit trail) */}
      <div className="mt-5">
        <SectionTitle>Change history</SectionTitle>
        <div className="card p-4">
          {histRows.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>No history yet.</p> : (
            <ol className="space-y-4">
              {histRows.map((h, i) => (
                <li key={i} className="relative pl-5">
                  <span style={{ position: "absolute", left: 0, top: 4, width: 9, height: 9, borderRadius: "50%", background: h.title === "Disposed" ? "var(--danger)" : h.title === "Edited" ? "var(--info)" : h.title === "Retrieved" ? "var(--warn)" : "var(--brand)" }} />
                  {i < histRows.length - 1 && <span style={{ position: "absolute", left: 4, top: 13, bottom: -16, width: 1, background: "var(--border)" }} />}
                  <div className="text-sm font-medium">{h.title}</div>
                  <div className="text-xs" style={{ color: "var(--muted)" }}>{fmtDateTime(h.createdAt)}{h.actor ? ` · ${h.actor}` : ""}</div>
                  {h.isEdit && h.after ? (
                    <ul className="mt-1 space-y-0.5">
                      {Object.keys(h.after).map((k) => (
                        <li key={k} className="text-xs">
                          <span style={{ color: "var(--muted)" }}>{k}: </span>
                          <span style={{ textDecoration: "line-through", color: "var(--muted)" }}>{String((h.before as Record<string, unknown>)?.[k] ?? "—")}</span>
                          <span style={{ color: "var(--muted)" }}> → </span>
                          <span>{String((h.after as Record<string, unknown>)[k] ?? "—")}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (h.after && Object.keys(h.after).length > 0 ? (
                    <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{Object.entries(h.after).map(([k, v]) => `${k}: ${String(v)}`).join(" · ")}</div>
                  ) : null)}
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </div>
  );
}
