import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";

/* ---------- Sample type taxonomy ---------- */
export const STANDARD_SAMPLE_TYPES: { category: string; type: string; defaultTemp: string }[] = [
  { category: "Blood Derivatives", type: "Serum", defaultTemp: "-80°C" },
  { category: "Blood Derivatives", type: "Plasma-EDTA", defaultTemp: "-80°C" },
  { category: "Blood Derivatives", type: "Plasma-Heparin", defaultTemp: "-80°C" },
  { category: "Blood Derivatives", type: "Buffy Coat", defaultTemp: "-80°C" },
  { category: "Cells", type: "PBMC", defaultTemp: "LN2" },
  { category: "Whole Specimens", type: "Whole Blood", defaultTemp: "-20°C" },
  { category: "Whole Specimens", type: "Urine", defaultTemp: "-80°C" },
  { category: "Whole Specimens", type: "Saliva", defaultTemp: "-80°C" },
  { category: "Whole Specimens", type: "Stool", defaultTemp: "-80°C" },
  { category: "Whole Specimens", type: "CSF", defaultTemp: "-80°C" },
  { category: "Tissue", type: "Tissue-FFPE", defaultTemp: "Room Temp" },
  { category: "Tissue", type: "Tissue-Frozen", defaultTemp: "-80°C" },
  { category: "Other", type: "Nail Clippings", defaultTemp: "Room Temp" },
  { category: "Other", type: "Hair", defaultTemp: "Room Temp" },
];

// Seed the standard sample types for an org once (idempotent — no-op if any exist).
export async function ensureSampleTypes(orgId: string): Promise<void> {
  const c = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM lab_sample_type WHERE org_id=$1`, [orgId]))?.c ?? 0;
  if (c > 0) return;
  for (const t of STANDARD_SAMPLE_TYPES) {
    await q(`INSERT INTO lab_sample_type (id, org_id, category, type, default_temp) VALUES ($1,$2,$3,$4,$5)`,
      [id("lst"), orgId, t.category, t.type, t.defaultTemp]);
  }
}

/* ---------- Sample code: PROJ-YYYY-NNNN (per project, reset yearly) ---------- */
export async function nextSampleCode(projectId: string): Promise<string> {
  const proj = await one<{ code: string }>(`SELECT code FROM project WHERE id=$1`, [projectId]);
  const prefix = (proj?.code ?? "SAMPLE").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const year = new Date().getFullYear();
  const n = (await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM lab_sample WHERE project_id=$1 AND sample_code LIKE $2`, [projectId, `${prefix}-${year}-%`]
  ))?.c ?? 0;
  return `${prefix}-${year}-${String(n + 1).padStart(4, "0")}`;
}

/* ---------- Age (Appendix C) ---------- */
// Full age breakdown between a DOB and a reference date.
export function calcAge(dob: Date | string | null | undefined, on: Date | string): { years: number | null; months: number | null } {
  if (!dob) return { years: null, months: null };
  const b = new Date(dob), o = new Date(on);
  if (isNaN(b.getTime()) || isNaN(o.getTime())) return { years: null, months: null };
  let months = (o.getFullYear() - b.getFullYear()) * 12 + (o.getMonth() - b.getMonth());
  if (o.getDate() < b.getDate()) months -= 1;
  if (months < 0) months = 0;
  return { years: Math.floor(months / 12), months: months % 12 };
}
// Adults: years only; children <5: years + months; infants <1: months only.
export function formatAge(years: number | null | undefined, months: number | null | undefined): string {
  if ((years == null || years === undefined) && (months == null || months === undefined)) return "—";
  const y = years ?? 0, m = months ?? 0;
  if (y < 1) return `${m}m`;
  if (y < 5) return m > 0 ? `${y}y ${m}m` : `${y}y`;
  return `${y}y`;
}

/* ---------- PII masking (participant names) ---------- */
// A lab "manager" (org admin / super admin) may see participant names; everyone else
// works by Study ID + age only. This is the v1 mapping of the role matrix.
export function canSeePII(isOrgAdmin: boolean, isSuperAdmin: boolean): boolean {
  return !!(isOrgAdmin || isSuperAdmin);
}
export function maskName(name: string | null | undefined, canSee: boolean): string {
  if (!name) return "—";
  return canSee ? name : "••••••";
}

/* ---------- Project scoping ---------- */
// Admins see all org projects; everyone else only projects they are a member of.
export async function accessibleProjectIds(userId: string, orgId: string, isAdmin: boolean): Promise<string[]> {
  if (isAdmin) return (await q<{ id: string }>(`SELECT id FROM project WHERE org_id=$1`, [orgId])).map((r) => r.id);
  return (await q<{ id: string }>(
    `SELECT DISTINCT p.id FROM project p JOIN project_member m ON m.project_id=p.id WHERE p.org_id=$1 AND m.user_id=$2`, [orgId, userId]
  )).map((r) => r.id);
}
function inParams(ids: string[], start: number): string {
  return ids.map((_, i) => `$${start + i}`).join(",");
}

/* ---------- Sample listing with filters ---------- */
export type SampleFilters = { search?: string; projectId?: string; sampleTypeId?: string; status?: string; dateFrom?: string; dateTo?: string; abnormal?: boolean };
export type SampleRow = {
  id: string; sampleCode: string; studyId: string | null; participantName: string | null;
  ageYears: number | null; ageMonths: number | null; typeName: string | null; category: string | null;
  projectCode: string | null; collectionDate: string; storageEquipment: string | null; storageShelf: string | null;
  status: string; abnormalities: string | null;
  visitLabel: string | null; freezeThawCount: number; maxFreezeThaw: number | null;
};
export async function listSamples(orgId: string, projectIds: string[], f: SampleFilters): Promise<SampleRow[]> {
  if (projectIds.length === 0) return [];
  const where: string[] = [`s.org_id=$1`, `s.project_id IN (${inParams(projectIds, 2)})`];
  const params: unknown[] = [orgId, ...projectIds];
  let n = projectIds.length + 2;
  if (f.projectId) { where.push(`s.project_id=$${n}`); params.push(f.projectId); n++; }
  if (f.sampleTypeId) { where.push(`s.sample_type_id=$${n}`); params.push(f.sampleTypeId); n++; }
  if (f.status) { where.push(`s.status=$${n}`); params.push(f.status); n++; }
  if (f.dateFrom) { where.push(`s.collection_date >= $${n}`); params.push(f.dateFrom); n++; }
  if (f.dateTo) { where.push(`s.collection_date <= $${n}`); params.push(f.dateTo); n++; }
  if (f.abnormal) { where.push(`s.abnormalities IS NOT NULL AND s.abnormalities <> ''`); }
  if (f.search) {
    where.push(`(s.sample_code ILIKE $${n} OR pa.study_id ILIKE $${n} OR pa.name ILIKE $${n})`);
    params.push(`%${f.search}%`); n++;
  }
  return await q<SampleRow>(
    `SELECT s.id, s.sample_code AS "sampleCode", pa.study_id AS "studyId", pa.name AS "participantName",
            s.age_years AS "ageYears", s.age_months AS "ageMonths", st.type AS "typeName", st.category,
            p.code AS "projectCode", s.collection_date AS "collectionDate", s.storage_equipment AS "storageEquipment",
            s.storage_shelf AS "storageShelf", s.status, s.abnormalities,
            v.label AS "visitLabel", s.freeze_thaw_count AS "freezeThawCount", st.max_freeze_thaw AS "maxFreezeThaw"
     FROM lab_sample s
     LEFT JOIN lab_participant pa ON pa.id=s.participant_id
     LEFT JOIN lab_sample_type st ON st.id=s.sample_type_id
     LEFT JOIN lab_visit v ON v.id=s.visit_id
     LEFT JOIN project p ON p.id=s.project_id
     WHERE ${where.join(" AND ")}
     ORDER BY s.created_at DESC LIMIT 500`, params
  );
}

/* ---------- Dashboard stats ---------- */
export type LabStats = {
  totalActive: number; collectedThisMonth: number; collectedLastMonth: number;
  pendingAliquots: number; recentRetrievals: number; quarantined: number; expiringSoon: number;
  byType: { type: string; count: number }[]; byStatus: { status: string; count: number }[];
  byFreezer: { freezer: string; count: number }[];
  recent: { id: string; sampleCode: string; typeName: string | null; status: string; createdAt: string }[];
};
export async function labStats(orgId: string, projectIds: string[]): Promise<LabStats> {
  const empty: LabStats = { totalActive: 0, collectedThisMonth: 0, collectedLastMonth: 0, pendingAliquots: 0, recentRetrievals: 0, quarantined: 0, expiringSoon: 0, byType: [], byStatus: [], byFreezer: [], recent: [] };
  if (projectIds.length === 0) return empty;
  const pin = inParams(projectIds, 1);
  const scope = projectIds;
  const num = async (sql: string, extra: unknown[] = []) => (await one<{ c: number }>(sql, [...scope, ...extra]))?.c ?? 0;
  const totalActive = await num(`SELECT COUNT(*)::int c FROM lab_sample WHERE project_id IN (${pin}) AND status='active'`);
  const collectedThisMonth = await num(`SELECT COUNT(*)::int c FROM lab_sample WHERE project_id IN (${pin}) AND date_trunc('month', collection_date)=date_trunc('month', CURRENT_DATE)`);
  const collectedLastMonth = await num(`SELECT COUNT(*)::int c FROM lab_sample WHERE project_id IN (${pin}) AND date_trunc('month', collection_date)=date_trunc('month', CURRENT_DATE - INTERVAL '1 month')`);
  const pendingAliquots = await num(`SELECT COUNT(*)::int c FROM lab_sample WHERE project_id IN (${pin}) AND status='active' AND date_aliquoted IS NULL`);
  const quarantined = await num(`SELECT COUNT(*)::int c FROM lab_sample WHERE project_id IN (${pin}) AND status='quarantined'`);
  const recentRetrievals = (await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM lab_retrieval r JOIN lab_sample s ON s.id=r.sample_id WHERE s.project_id IN (${pin}) AND r.date_retrieved >= CURRENT_DATE - INTERVAL '7 days'`, scope))?.c ?? 0;
  const byType = await q<{ type: string; count: number }>(
    `SELECT COALESCE(st.type,'Unspecified') AS type, COUNT(*)::int count FROM lab_sample s LEFT JOIN lab_sample_type st ON st.id=s.sample_type_id WHERE s.project_id IN (${pin}) AND s.status<>'disposed' GROUP BY st.type ORDER BY count DESC`, scope);
  const byStatus = await q<{ status: string; count: number }>(
    `SELECT status, COUNT(*)::int count FROM lab_sample WHERE project_id IN (${pin}) GROUP BY status ORDER BY count DESC`, scope);
  const byFreezer = await q<{ freezer: string; count: number }>(
    `SELECT COALESCE(storage_equipment,'(unstored)') AS freezer, COUNT(*)::int count FROM lab_sample WHERE project_id IN (${pin}) AND status NOT IN ('disposed') GROUP BY storage_equipment ORDER BY count DESC LIMIT 8`, scope);
  const recent = await q<{ id: string; sampleCode: string; typeName: string | null; status: string; createdAt: string }>(
    `SELECT s.id, s.sample_code AS "sampleCode", st.type AS "typeName", s.status, s.created_at AS "createdAt" FROM lab_sample s LEFT JOIN lab_sample_type st ON st.id=s.sample_type_id WHERE s.project_id IN (${pin}) ORDER BY s.created_at DESC LIMIT 10`, scope);
  return { totalActive, collectedThisMonth, collectedLastMonth, pendingAliquots, recentRetrievals, quarantined, expiringSoon: 0, byType, byStatus, byFreezer, recent };
}
