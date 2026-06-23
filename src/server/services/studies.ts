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

export type AERow = { id: string; participantRef: string | null; term: string; onsetDate: string | null; severity: string; serious: boolean; saeCriteria: string | null; causality: string | null; expectedness: string | null; outcome: string | null; reportedDate: string | null; reportedTo: string | null; status: string; description: string | null; recordedByName: string | null };
export async function studyAdverseEvents(studyId: string): Promise<AERow[]> {
  return await q<AERow>(
    `SELECT id, participant_ref AS "participantRef", term, onset_date::text AS "onsetDate", severity, serious, sae_criteria AS "saeCriteria", causality, expectedness, outcome,
            reported_date::text AS "reportedDate", reported_to AS "reportedTo", status, description, recorded_by_name AS "recordedByName"
     FROM study_ae WHERE study_id=$1 ORDER BY serious DESC, COALESCE(onset_date, created_at::date) DESC, created_at DESC`, [studyId]);
}

export type DeviationRow = { id: string; participantRef: string | null; deviationDate: string | null; kind: string; severity: string; description: string; rootCause: string | null; correctiveAction: string | null; reported: boolean; reportedDate: string | null; status: string; recordedByName: string | null };
export async function studyDeviations(studyId: string): Promise<DeviationRow[]> {
  return await q<DeviationRow>(
    `SELECT id, participant_ref AS "participantRef", deviation_date::text AS "deviationDate", kind, severity, description, root_cause AS "rootCause", corrective_action AS "correctiveAction",
            reported, reported_date::text AS "reportedDate", status, recorded_by_name AS "recordedByName"
     FROM study_deviation WHERE study_id=$1 ORDER BY (severity='major') DESC, COALESCE(deviation_date, created_at::date) DESC, created_at DESC`, [studyId]);
}

export type MonitoringRow = { id: string; visitDate: string | null; kind: string; monitorName: string | null; site: string | null; findings: string | null; actionItems: string | null; reportReceived: boolean; status: string; recordedByName: string | null };
export async function studyMonitoringVisits(studyId: string): Promise<MonitoringRow[]> {
  return await q<MonitoringRow>(
    `SELECT id, visit_date::text AS "visitDate", kind, monitor_name AS "monitorName", site, findings, action_items AS "actionItems", report_received AS "reportReceived", status, recorded_by_name AS "recordedByName"
     FROM study_monitoring WHERE study_id=$1 ORDER BY COALESCE(visit_date, created_at::date) DESC, created_at DESC`, [studyId]);
}

export type ComplianceCounts = { openSAEs: number; totalAEs: number; openAEs: number; majorDeviations: number; openDeviations: number; openMonitoring: number };
export async function studyComplianceCounts(studyId: string): Promise<ComplianceCounts> {
  const ae = await one<{ open_sae: number; total: number; open_ae: number }>(
    `SELECT COUNT(*) FILTER (WHERE serious AND status<>'resolved')::int open_sae, COUNT(*)::int total, COUNT(*) FILTER (WHERE status<>'resolved')::int open_ae FROM study_ae WHERE study_id=$1`, [studyId]);
  const dev = await one<{ major: number; open: number }>(
    `SELECT COUNT(*) FILTER (WHERE severity='major' AND status<>'resolved')::int major, COUNT(*) FILTER (WHERE status<>'resolved')::int open FROM study_deviation WHERE study_id=$1`, [studyId]);
  const mon = await one<{ open: number }>(`SELECT COUNT(*) FILTER (WHERE status<>'closed')::int open FROM study_monitoring WHERE study_id=$1`, [studyId]);
  return { openSAEs: ae?.open_sae ?? 0, totalAEs: ae?.total ?? 0, openAEs: ae?.open_ae ?? 0, majorDeviations: dev?.major ?? 0, openDeviations: dev?.open ?? 0, openMonitoring: mon?.open ?? 0 };
}

// Org-wide safety/quality rollup for the studies dashboard.
export async function complianceStats(orgId: string, projectIds: string[]): Promise<{ openSAEs: number; majorDeviations: number; openMonitoring: number }> {
  if (projectIds.length === 0) return { openSAEs: 0, majorDeviations: 0, openMonitoring: 0 };
  const ph = projectIds.map((_, i) => `$${i + 2}`).join(",");
  const r = await one<{ sae: number; dev: number; mon: number }>(
    `SELECT
       (SELECT COUNT(*) FROM study_ae a JOIN study s ON s.id=a.study_id WHERE s.org_id=$1 AND s.project_id IN (${ph}) AND a.serious AND a.status<>'resolved')::int sae,
       (SELECT COUNT(*) FROM study_deviation d JOIN study s ON s.id=d.study_id WHERE s.org_id=$1 AND s.project_id IN (${ph}) AND d.severity='major' AND d.status<>'resolved')::int dev,
       (SELECT COUNT(*) FROM study_monitoring m JOIN study s ON s.id=m.study_id WHERE s.org_id=$1 AND s.project_id IN (${ph}) AND m.status<>'closed')::int mon`,
    [orgId, ...projectIds]);
  return { openSAEs: r?.sae ?? 0, majorDeviations: r?.dev ?? 0, openMonitoring: r?.mon ?? 0 };
}
