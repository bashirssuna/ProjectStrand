import "server-only";
import { q, one } from "@/server/db";

// Ordered hiring pipeline. `rejected` / `withdrawn` are terminal off-pipeline states.
export const STAGES = ["applied", "screening", "shortlisted", "interview", "offer", "hired"] as const;
export const TERMINAL = ["rejected", "withdrawn"] as const;
export type Stage = (typeof STAGES)[number] | (typeof TERMINAL)[number];

export type Opening = {
  id: string; reference: string | null; title: string; department: string | null; departmentId: string | null;
  projectId: string | null; employmentType: string; location: string | null; positions: number;
  description: string | null; responsibilities: string | null; requirements: string | null;
  salaryMin: number | null; salaryMax: number | null; currency: string | null; hiringManager: string | null;
  status: string; openedDate: string | null; closingDate: string | null; applicants: number;
};

export async function listOpenings(orgId: string, f: { status?: string; search?: string } = {}): Promise<Opening[]> {
  const where: string[] = ["o.org_id=$1"];
  const params: unknown[] = [orgId];
  let n = 2;
  if (f.status) { where.push(`o.status=$${n}`); params.push(f.status); n++; }
  if (f.search) { where.push(`(o.title ILIKE $${n} OR o.reference ILIKE $${n})`); params.push(`%${f.search}%`); n++; }
  return q<Opening>(
    `SELECT o.id, o.reference, o.title, o.department, o.department_id AS "departmentId", o.project_id AS "projectId",
            o.employment_type AS "employmentType", o.location, o.positions, o.description, o.responsibilities, o.requirements,
            o.salary_min::float8 AS "salaryMin", o.salary_max::float8 AS "salaryMax", o.currency, o.hiring_manager AS "hiringManager",
            o.status, o.opened_date AS "openedDate", o.closing_date AS "closingDate",
            (SELECT COUNT(*) FROM job_application a WHERE a.opening_id=o.id)::int AS applicants
     FROM job_opening o WHERE ${where.join(" AND ")} ORDER BY o.created_at DESC LIMIT 500`, params);
}

export async function getOpening(orgId: string, id: string): Promise<Opening | null> {
  const r = await listOpenings(orgId, {});
  return r.find((o) => o.id === id) ?? null;
}

export async function openingStats(orgId: string): Promise<{ total: number; open: number; filled: number; candidates: number; toReview: number }> {
  const s = await one<{ total: number; open: number; filled: number }>(
    `SELECT COUNT(*)::int total,
            COUNT(*) FILTER (WHERE status IN ('open','on_hold'))::int open,
            COUNT(*) FILTER (WHERE status='filled')::int filled
     FROM job_opening WHERE org_id=$1`, [orgId]);
  const c = await one<{ candidates: number; toReview: number }>(
    `SELECT COUNT(DISTINCT candidate_id)::int candidates,
            COUNT(*) FILTER (WHERE stage IN ('applied','screening'))::int "toReview"
     FROM job_application WHERE org_id=$1`, [orgId]);
  return { total: s?.total ?? 0, open: s?.open ?? 0, filled: s?.filled ?? 0, candidates: c?.candidates ?? 0, toReview: c?.toReview ?? 0 };
}

export type ApplicationRow = {
  id: string; candidateId: string; fullName: string; email: string | null; phone: string | null;
  currentTitle: string | null; source: string | null; cvKey: string | null; stage: string;
  appliedDate: string | null; rejectionReason: string | null; interviews: number; avgScore: number | null;
};

export async function listApplications(orgId: string, openingId: string): Promise<ApplicationRow[]> {
  return q<ApplicationRow>(
    `SELECT a.id, a.candidate_id AS "candidateId", c.full_name AS "fullName", c.email, c.phone, c.current_title AS "currentTitle",
            c.source, c.cv_key AS "cvKey", a.stage, a.applied_date AS "appliedDate", a.rejection_reason AS "rejectionReason",
            (SELECT COUNT(*) FROM interview i WHERE i.application_id=a.id)::int AS interviews,
            (SELECT ROUND(AVG((COALESCE(s.technical,0)+COALESCE(s.experience,0)+COALESCE(s.communication,0)+COALESCE(s.motivation,0))/4.0),1)
               FROM interview i JOIN interview_score s ON s.interview_id=i.id WHERE i.application_id=a.id)::float8 AS "avgScore"
     FROM job_application a JOIN candidate c ON c.id=a.candidate_id
     WHERE a.opening_id=$1 AND a.org_id=$2 ORDER BY a.created_at`, [openingId, orgId]);
}

export type ApplicationDetail = {
  id: string; openingId: string; openingTitle: string; openingStatus: string; stage: string; appliedDate: string | null;
  coverNote: string | null; rejectionReason: string | null; hiredEmployeeId: string | null;
  candidateId: string; fullName: string; email: string | null; phone: string | null; gender: string | null; location: string | null;
  currentTitle: string | null; currentEmployer: string | null; highestQualification: string | null;
  yearsExperience: number | null; source: string | null; cvKey: string | null; cvName: string | null;
  defaultCurrency: string | null; salaryMin: number | null; salaryMax: number | null; employmentType: string;
};

export async function getApplication(orgId: string, appId: string): Promise<ApplicationDetail | null> {
  return one<ApplicationDetail>(
    `SELECT a.id, a.opening_id AS "openingId", o.title AS "openingTitle", o.status AS "openingStatus", a.stage,
            a.applied_date AS "appliedDate", a.cover_note AS "coverNote", a.rejection_reason AS "rejectionReason",
            a.hired_employee_id AS "hiredEmployeeId",
            c.id AS "candidateId", c.full_name AS "fullName", c.email, c.phone, c.gender, c.location,
            c.current_title AS "currentTitle", c.current_employer AS "currentEmployer", c.highest_qualification AS "highestQualification",
            c.years_experience::float8 AS "yearsExperience", c.source, c.cv_key AS "cvKey", c.cv_name AS "cvName",
            o.currency AS "defaultCurrency", o.salary_min::float8 AS "salaryMin", o.salary_max::float8 AS "salaryMax", o.employment_type AS "employmentType"
     FROM job_application a JOIN candidate c ON c.id=a.candidate_id JOIN job_opening o ON o.id=a.opening_id
     WHERE a.id=$1 AND a.org_id=$2`, [appId, orgId]);
}

export type InterviewRow = {
  id: string; round: number; kind: string; mode: string; scheduledAt: string | null; location: string | null;
  status: string; notes: string | null; scoreCount: number; avgScore: number | null;
};
export async function listInterviews(orgId: string, appId: string): Promise<InterviewRow[]> {
  return q<InterviewRow>(
    `SELECT i.id, i.round, i.kind, i.mode, i.scheduled_at AS "scheduledAt", i.location, i.status, i.notes,
            (SELECT COUNT(*) FROM interview_score s WHERE s.interview_id=i.id)::int AS "scoreCount",
            (SELECT ROUND(AVG((COALESCE(s.technical,0)+COALESCE(s.experience,0)+COALESCE(s.communication,0)+COALESCE(s.motivation,0))/4.0),1)
               FROM interview_score s WHERE s.interview_id=i.id)::float8 AS "avgScore"
     FROM interview i WHERE i.application_id=$1 AND i.org_id=$2 ORDER BY i.round, i.created_at`, [appId, orgId]);
}

export type ScoreRow = {
  id: string; panelist: string; technical: number | null; experience: number | null; communication: number | null;
  motivation: number | null; recommendation: string | null; coiDeclared: boolean; comments: string | null;
};
export async function listScores(orgId: string, interviewId: string): Promise<ScoreRow[]> {
  return q<ScoreRow>(
    `SELECT id, panelist, technical::float8 technical, experience::float8 experience, communication::float8 communication,
            motivation::float8 motivation, recommendation, coi_declared AS "coiDeclared", comments
     FROM interview_score WHERE interview_id=$1 AND org_id=$2 ORDER BY created_at`, [interviewId, orgId]);
}

export async function getOffer(orgId: string, appId: string): Promise<{ id: string; salary: number | null; currency: string | null; employmentType: string | null; startDate: string | null; status: string; offerDate: string | null; notes: string | null } | null> {
  return one(
    `SELECT id, salary::float8 salary, currency, employment_type AS "employmentType", start_date AS "startDate", status, offer_date AS "offerDate", notes
     FROM job_offer WHERE application_id=$1 AND org_id=$2 ORDER BY created_at DESC LIMIT 1`, [appId, orgId]);
}
