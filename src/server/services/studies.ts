import "server-only";
import { q, one } from "@/server/db";

function inParams(ids: string[], start: number): string {
  return ids.map((_, i) => `$${start + i}`).join(",");
}

export type StudyFilters = { search?: string; projectId?: string; studyType?: string; status?: string };
export type StudyRow = {
  id: string; code: string | null; title: string; studyType: string; phase: string | null; status: string;
  projectCode: string | null; piName: string | null; targetEnrollment: number | null;
  enrolled: number; expiringApprovals: number;
};

// Studies visible to the user (scoped to accessible projects), with enrollment rollup
// and a count of approvals expiring within 60 days.
export async function listStudies(orgId: string, projectIds: string[], f: StudyFilters): Promise<StudyRow[]> {
  if (projectIds.length === 0) return [];
  const where: string[] = [`s.org_id=$1`, `s.project_id IN (${inParams(projectIds, 2)})`];
  const params: unknown[] = [orgId, ...projectIds];
  let n = projectIds.length + 2;
  if (f.projectId) { where.push(`s.project_id=$${n}`); params.push(f.projectId); n++; }
  if (f.studyType) { where.push(`s.study_type=$${n}`); params.push(f.studyType); n++; }
  if (f.status) { where.push(`s.status=$${n}`); params.push(f.status); n++; }
  if (f.search) { where.push(`(s.title ILIKE $${n} OR s.code ILIKE $${n} OR s.registration_number ILIKE $${n})`); params.push(`%${f.search}%`); n++; }
  return await q<StudyRow>(
    `SELECT s.id, s.code, s.title, s.study_type AS "studyType", s.phase, s.status, p.code AS "projectCode", s.pi_name AS "piName", s.target_enrollment AS "targetEnrollment",
            COALESCE((SELECT SUM(enrolled) FROM study_enrollment e WHERE e.study_id=s.id),0)::int AS enrolled,
            COALESCE((SELECT COUNT(*) FROM study_approval a WHERE a.study_id=s.id AND a.status='approved' AND a.expiry_date IS NOT NULL AND a.expiry_date <= CURRENT_DATE + INTERVAL '60 days'),0)::int AS "expiringApprovals"
     FROM study s LEFT JOIN project p ON p.id=s.project_id
     WHERE ${where.join(" AND ")} ORDER BY s.created_at DESC LIMIT 500`, params
  );
}

export type EnrollmentTotals = { screened: number; enrolled: number; withdrawn: number; completed: number; active: number };
export async function studyEnrollmentTotals(studyId: string): Promise<EnrollmentTotals> {
  const r = await one<{ screened: number; enrolled: number; withdrawn: number; completed: number }>(
    `SELECT COALESCE(SUM(screened),0)::int screened, COALESCE(SUM(enrolled),0)::int enrolled, COALESCE(SUM(withdrawn),0)::int withdrawn, COALESCE(SUM(completed),0)::int completed FROM study_enrollment WHERE study_id=$1`, [studyId]
  );
  const screened = r?.screened ?? 0, enrolled = r?.enrolled ?? 0, withdrawn = r?.withdrawn ?? 0, completed = r?.completed ?? 0;
  return { screened, enrolled, withdrawn, completed, active: Math.max(0, enrolled - withdrawn - completed) };
}

export type ExpiringApproval = { id: string; studyId: string; studyTitle: string; authority: string; referenceNumber: string | null; expiryDate: string; daysLeft: number };
// Approvals expiring within `withinDays` (or already expired) across the user's studies.
export async function expiringApprovals(orgId: string, projectIds: string[], withinDays: number): Promise<ExpiringApproval[]> {
  if (projectIds.length === 0) return [];
  return await q<ExpiringApproval>(
    `SELECT a.id, a.study_id AS "studyId", s.title AS "studyTitle", a.authority, a.reference_number AS "referenceNumber",
            a.expiry_date::text AS "expiryDate", (a.expiry_date - CURRENT_DATE) AS "daysLeft"
     FROM study_approval a JOIN study s ON s.id=a.study_id
     WHERE s.org_id=$1 AND s.project_id IN (${inParams(projectIds, 2)}) AND a.status='approved'
       AND a.expiry_date IS NOT NULL AND a.expiry_date <= CURRENT_DATE + ($${projectIds.length + 2} || ' days')::interval
     ORDER BY a.expiry_date ASC`, [orgId, ...projectIds, String(withinDays)]
  );
}

export type StudyStats = { total: number; byStatus: { status: string; count: number }[]; byType: { studyType: string; count: number }[]; recruiting: number };
export async function studyStats(orgId: string, projectIds: string[]): Promise<StudyStats> {
  const empty: StudyStats = { total: 0, byStatus: [], byType: [], recruiting: 0 };
  if (projectIds.length === 0) return empty;
  const pin = inParams(projectIds, 1);
  const total = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM study WHERE project_id IN (${pin})`, projectIds))?.c ?? 0;
  const recruiting = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM study WHERE project_id IN (${pin}) AND status IN ('recruiting','active')`, projectIds))?.c ?? 0;
  const byStatus = await q<{ status: string; count: number }>(`SELECT status, COUNT(*)::int count FROM study WHERE project_id IN (${pin}) GROUP BY status ORDER BY count DESC`, projectIds);
  const byType = await q<{ studyType: string; count: number }>(`SELECT study_type AS "studyType", COUNT(*)::int count FROM study WHERE project_id IN (${pin}) GROUP BY study_type ORDER BY count DESC`, projectIds);
  return { total, byStatus, byType, recruiting };
}
