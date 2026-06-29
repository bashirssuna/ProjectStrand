import "server-only";
import { q, one } from "@/server/db";

export const APPRAISAL_STATUSES = ["draft", "self_assessment", "manager_review", "completed", "acknowledged"] as const;
export const RATING_LABELS: Record<number, string> = {
  1: "Poor", 2: "Fair", 3: "Good", 4: "Very good", 5: "Excellent",
};
export function ratingLabel(r: number | null | undefined): string | null {
  if (r == null) return null;
  return RATING_LABELS[Math.round(r)] ?? null;
}

export type Cycle = {
  id: string; name: string; kind: string; periodStart: string | null; periodEnd: string | null;
  dueDate: string | null; ratingMax: number; status: string; appraisals: number; completed: number;
};

export async function listCycles(orgId: string): Promise<Cycle[]> {
  return q<Cycle>(
    `SELECT c.id, c.name, c.kind, c.period_start AS "periodStart", c.period_end AS "periodEnd", c.due_date AS "dueDate",
            c.rating_max AS "ratingMax", c.status,
            (SELECT COUNT(*) FROM appraisal a WHERE a.cycle_id=c.id)::int AS appraisals,
            (SELECT COUNT(*) FROM appraisal a WHERE a.cycle_id=c.id AND a.status IN ('completed','acknowledged'))::int AS completed
     FROM appraisal_cycle c WHERE c.org_id=$1 ORDER BY c.created_at DESC`, [orgId]);
}

export async function getCycle(orgId: string, id: string): Promise<Cycle | null> {
  return (await listCycles(orgId)).find((c) => c.id === id) ?? null;
}

export async function orgAppraisalStats(orgId: string): Promise<{ cycles: number; openCycles: number; inProgress: number; completed: number; avgRating: number | null }> {
  const c = await one<{ cycles: number; openCycles: number }>(
    `SELECT COUNT(*)::int cycles, COUNT(*) FILTER (WHERE status='open')::int "openCycles" FROM appraisal_cycle WHERE org_id=$1`, [orgId]);
  const a = await one<{ inProgress: number; completed: number; avgRating: number | null }>(
    `SELECT COUNT(*) FILTER (WHERE status IN ('self_assessment','manager_review'))::int "inProgress",
            COUNT(*) FILTER (WHERE status IN ('completed','acknowledged'))::int completed,
            ROUND(AVG(overall_rating) FILTER (WHERE status IN ('completed','acknowledged')),1)::float8 "avgRating"
     FROM appraisal WHERE org_id=$1`, [orgId]);
  return { cycles: c?.cycles ?? 0, openCycles: c?.openCycles ?? 0, inProgress: a?.inProgress ?? 0, completed: a?.completed ?? 0, avgRating: a?.avgRating ?? null };
}

export type AppraisalRow = {
  id: string; employeeId: string; employeeName: string; jobTitle: string | null; department: string | null;
  appraiserName: string | null; status: string; overallRating: number | null; items: number; managerAvg: number | null;
  archived: boolean; signatures: number;
};

export async function listAppraisals(orgId: string, cycleId: string, includeArchived = false): Promise<AppraisalRow[]> {
  return q<AppraisalRow>(
    `SELECT a.id, a.employee_id AS "employeeId", (e.first_name || ' ' || e.last_name) AS "employeeName",
            e.job_title AS "jobTitle", e.department,
            COALESCE(a.appraiser_name, ae.first_name || ' ' || ae.last_name) AS "appraiserName",
            a.status, a.overall_rating::float8 AS "overallRating", a.archived,
            ((a.employee_signed_at IS NOT NULL)::int + (a.appraiser_signed_at IS NOT NULL)::int + (a.hr_signed_at IS NOT NULL)::int) AS signatures,
            (SELECT COUNT(*) FROM appraisal_item i WHERE i.appraisal_id=a.id)::int AS items,
            (SELECT ROUND(AVG(i.manager_rating),1) FROM appraisal_item i WHERE i.appraisal_id=a.id)::float8 AS "managerAvg"
     FROM appraisal a JOIN employee e ON e.id=a.employee_id
     LEFT JOIN employee ae ON ae.id=a.appraiser_employee_id
     WHERE a.cycle_id=$1 AND a.org_id=$2 AND (a.archived = false OR $3) ORDER BY e.first_name, e.last_name`, [cycleId, orgId, includeArchived]);
}

// Appraisals the logged-in employee is involved in (as appraisee or appraiser).
export type MyAppraisalRow = {
  id: string; cycleName: string; cycleId: string; status: string; overallRating: number | null;
  role: "appraisee" | "appraiser"; employeeName: string; appraiserName: string | null; archived: boolean;
};
export async function listAppraisalsForUser(orgId: string, employeeId: string): Promise<MyAppraisalRow[]> {
  return q<MyAppraisalRow>(
    `SELECT a.id, c.name AS "cycleName", a.cycle_id AS "cycleId", a.status, a.overall_rating::float8 AS "overallRating",
            CASE WHEN a.employee_id=$2 THEN 'appraisee' ELSE 'appraiser' END AS role,
            (e.first_name || ' ' || e.last_name) AS "employeeName",
            COALESCE(a.appraiser_name, ae.first_name || ' ' || ae.last_name) AS "appraiserName", a.archived
     FROM appraisal a JOIN appraisal_cycle c ON c.id=a.cycle_id JOIN employee e ON e.id=a.employee_id
     LEFT JOIN employee ae ON ae.id=a.appraiser_employee_id
     WHERE a.org_id=$1 AND a.archived=false AND ($2 IN (a.employee_id, a.appraiser_employee_id))
     ORDER BY a.created_at DESC`, [orgId, employeeId]);
}

export type AppraisalDetail = {
  id: string; cycleId: string; cycleName: string; cycleStatus: string; ratingMax: number;
  employeeId: string; employeeName: string; jobTitle: string | null; department: string | null;
  appraiserName: string | null; appraiserEmployeeId: string | null; status: string;
  overallRating: number | null; managerComments: string | null; employeeComments: string | null;
  developmentPlan: string | null; hrComments: string | null; acknowledgedAt: string | null; archived: boolean;
  selfAvg: number | null; managerAvg: number | null;
  employeeSignedAt: string | null; employeeSignature: string | null; employeeSignedName: string | null;
  appraiserSignedAt: string | null; appraiserSignature: string | null; appraiserSignedName: string | null;
  hrSignedAt: string | null; hrSignature: string | null; hrSignedName: string | null;
};

export async function getAppraisal(orgId: string, id: string): Promise<AppraisalDetail | null> {
  return one<AppraisalDetail>(
    `SELECT a.id, a.cycle_id AS "cycleId", c.name AS "cycleName", c.status AS "cycleStatus", c.rating_max AS "ratingMax",
            a.employee_id AS "employeeId", (e.first_name || ' ' || e.last_name) AS "employeeName", e.job_title AS "jobTitle", e.department,
            COALESCE(a.appraiser_name, ae.first_name || ' ' || ae.last_name) AS "appraiserName", a.appraiser_employee_id AS "appraiserEmployeeId",
            a.status, a.overall_rating::float8 AS "overallRating", a.manager_comments AS "managerComments",
            a.employee_comments AS "employeeComments", a.development_plan AS "developmentPlan", a.hr_comments AS "hrComments",
            a.acknowledged_at AS "acknowledgedAt", a.archived,
            a.employee_signed_at AS "employeeSignedAt", a.employee_signature AS "employeeSignature", a.employee_signed_name AS "employeeSignedName",
            a.appraiser_signed_at AS "appraiserSignedAt", a.appraiser_signature AS "appraiserSignature", a.appraiser_signed_name AS "appraiserSignedName",
            a.hr_signed_at AS "hrSignedAt", a.hr_signature AS "hrSignature", a.hr_signed_name AS "hrSignedName",
            (SELECT ROUND(AVG(i.self_rating),1) FROM appraisal_item i WHERE i.appraisal_id=a.id)::float8 AS "selfAvg",
            (SELECT ROUND(AVG(i.manager_rating),1) FROM appraisal_item i WHERE i.appraisal_id=a.id)::float8 AS "managerAvg"
     FROM appraisal a JOIN appraisal_cycle c ON c.id=a.cycle_id JOIN employee e ON e.id=a.employee_id
     LEFT JOIN employee ae ON ae.id=a.appraiser_employee_id
     WHERE a.id=$1 AND a.org_id=$2`, [id, orgId]);
}

export type AppraisalItem = {
  id: string; kind: string; title: string; description: string | null; weight: number | null;
  target: string | null; result: string | null; selfRating: number | null; selfComment: string | null;
  managerRating: number | null; managerComment: string | null;
};

export async function listItems(orgId: string, appraisalId: string): Promise<AppraisalItem[]> {
  return q<AppraisalItem>(
    `SELECT id, kind, title, description, weight::float8 weight, target, result,
            self_rating::float8 AS "selfRating", self_comment AS "selfComment",
            manager_rating::float8 AS "managerRating", manager_comment AS "managerComment"
     FROM appraisal_item WHERE appraisal_id=$1 AND org_id=$2 ORDER BY sort_order, created_at`, [appraisalId, orgId]);
}
