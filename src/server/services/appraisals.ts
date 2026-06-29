import "server-only";
import { q, one } from "@/server/db";

export const APPRAISAL_STATUSES = ["draft", "self_assessment", "manager_review", "completed", "acknowledged"] as const;
export const RATING_LABELS: Record<number, string> = {
  1: "Unsatisfactory", 2: "Needs improvement", 3: "Meets expectations", 4: "Exceeds expectations", 5: "Outstanding",
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
};

export async function listAppraisals(orgId: string, cycleId: string): Promise<AppraisalRow[]> {
  return q<AppraisalRow>(
    `SELECT a.id, a.employee_id AS "employeeId", (e.first_name || ' ' || e.last_name) AS "employeeName",
            e.job_title AS "jobTitle", e.department,
            COALESCE(a.appraiser_name, ae.first_name || ' ' || ae.last_name) AS "appraiserName",
            a.status, a.overall_rating::float8 AS "overallRating",
            (SELECT COUNT(*) FROM appraisal_item i WHERE i.appraisal_id=a.id)::int AS items,
            (SELECT ROUND(AVG(i.manager_rating),1) FROM appraisal_item i WHERE i.appraisal_id=a.id)::float8 AS "managerAvg"
     FROM appraisal a JOIN employee e ON e.id=a.employee_id
     LEFT JOIN employee ae ON ae.id=a.appraiser_employee_id
     WHERE a.cycle_id=$1 AND a.org_id=$2 ORDER BY e.first_name, e.last_name`, [cycleId, orgId]);
}

export type AppraisalDetail = {
  id: string; cycleId: string; cycleName: string; cycleStatus: string; ratingMax: number;
  employeeId: string; employeeName: string; jobTitle: string | null; department: string | null;
  appraiserName: string | null; appraiserEmployeeId: string | null; status: string;
  overallRating: number | null; managerComments: string | null; employeeComments: string | null;
  developmentPlan: string | null; acknowledgedAt: string | null;
  selfAvg: number | null; managerAvg: number | null;
};

export async function getAppraisal(orgId: string, id: string): Promise<AppraisalDetail | null> {
  return one<AppraisalDetail>(
    `SELECT a.id, a.cycle_id AS "cycleId", c.name AS "cycleName", c.status AS "cycleStatus", c.rating_max AS "ratingMax",
            a.employee_id AS "employeeId", (e.first_name || ' ' || e.last_name) AS "employeeName", e.job_title AS "jobTitle", e.department,
            COALESCE(a.appraiser_name, ae.first_name || ' ' || ae.last_name) AS "appraiserName", a.appraiser_employee_id AS "appraiserEmployeeId",
            a.status, a.overall_rating::float8 AS "overallRating", a.manager_comments AS "managerComments",
            a.employee_comments AS "employeeComments", a.development_plan AS "developmentPlan", a.acknowledged_at AS "acknowledgedAt",
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
