import "server-only";
import { q, one } from "@/server/db";

function inParams(ids: string[], start: number): string {
  return ids.map((_, i) => `$${start + i}`).join(",");
}

export type AssayRow = { id: string; name: string; category: string | null; method: string | null; unit: string | null; turnaroundDays: number | null; status: string };
export async function listAssays(orgId: string, includeInactive = false): Promise<AssayRow[]> {
  return await q<AssayRow>(
    `SELECT id, name, category, method, unit, turnaround_days AS "turnaroundDays", status FROM lab_assay WHERE org_id=$1 ${includeInactive ? "" : "AND status='active'"} ORDER BY category NULLS LAST, name`, [orgId]
  );
}

export type TestRow = {
  id: string; assayName: string | null; assayCatalogueName: string | null; status: string; requestedByName: string | null; requestedDate: string | null;
  method: string | null; result: string | null; resultNumeric: number | null; unit: string | null; interpretation: string | null; performedByName: string | null; resultDate: string | null; notes: string | null;
};
export async function sampleTests(sampleId: string): Promise<TestRow[]> {
  return await q<TestRow>(
    `SELECT t.id, t.assay_name AS "assayName", a.name AS "assayCatalogueName", t.status, t.requested_by_name AS "requestedByName", t.requested_date::text AS "requestedDate",
            t.method, t.result, t.result_numeric AS "resultNumeric", t.unit, t.interpretation, t.performed_by_name AS "performedByName", t.result_date::text AS "resultDate", t.notes
     FROM lab_test t LEFT JOIN lab_assay a ON a.id=t.assay_id WHERE t.sample_id=$1 ORDER BY t.created_at DESC`, [sampleId]
  );
}

export type WorklistRow = {
  id: string; sampleId: string; sampleCode: string; projectCode: string | null; studyId: string | null;
  assay: string | null; status: string; requestedDate: string | null; result: string | null; interpretation: string | null; resultDate: string | null;
};
export type TestFilters = { status?: string; assayId?: string; projectId?: string; search?: string };
export async function listTests(orgId: string, projectIds: string[], f: TestFilters): Promise<WorklistRow[]> {
  if (projectIds.length === 0) return [];
  const where: string[] = [`t.org_id=$1`, `s.project_id IN (${inParams(projectIds, 2)})`];
  const params: unknown[] = [orgId, ...projectIds];
  let n = projectIds.length + 2;
  if (f.status) { where.push(`t.status=$${n}`); params.push(f.status); n++; }
  if (f.assayId) { where.push(`t.assay_id=$${n}`); params.push(f.assayId); n++; }
  if (f.projectId) { where.push(`s.project_id=$${n}`); params.push(f.projectId); n++; }
  if (f.search) { where.push(`(s.sample_code ILIKE $${n} OR pa.study_id ILIKE $${n} OR COALESCE(a.name, t.assay_name) ILIKE $${n})`); params.push(`%${f.search}%`); n++; }
  return await q<WorklistRow>(
    `SELECT t.id, t.sample_id AS "sampleId", s.sample_code AS "sampleCode", p.code AS "projectCode", pa.study_id AS "studyId",
            COALESCE(a.name, t.assay_name) AS assay, t.status, t.requested_date::text AS "requestedDate", t.result, t.interpretation, t.result_date::text AS "resultDate"
     FROM lab_test t
     JOIN lab_sample s ON s.id=t.sample_id
     LEFT JOIN lab_assay a ON a.id=t.assay_id
     LEFT JOIN lab_participant pa ON pa.id=s.participant_id
     LEFT JOIN project p ON p.id=s.project_id
     WHERE ${where.join(" AND ")}
     ORDER BY CASE t.status WHEN 'requested' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END, t.created_at DESC LIMIT 500`, params
  );
}

export type TestStats = { requested: number; inProgress: number; completed: number; total: number };
export async function testStats(orgId: string, projectIds: string[]): Promise<TestStats> {
  const empty: TestStats = { requested: 0, inProgress: 0, completed: 0, total: 0 };
  if (projectIds.length === 0) return empty;
  const rows = await q<{ status: string; c: number }>(
    `SELECT t.status, COUNT(*)::int c FROM lab_test t JOIN lab_sample s ON s.id=t.sample_id WHERE t.org_id=$1 AND s.project_id IN (${inParams(projectIds, 2)}) GROUP BY t.status`, [orgId, ...projectIds]
  );
  const get = (s: string) => rows.find((r) => r.status === s)?.c ?? 0;
  return { requested: get("requested"), inProgress: get("in_progress"), completed: get("completed"), total: rows.reduce((a, r) => a + r.c, 0) };
}
