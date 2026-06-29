import "server-only";
import { q, one } from "@/server/db";

// Type-specific workflow stages and outcomes.
export const STAGES: Record<string, string[]> = {
  grievance: ["open", "acknowledged", "investigation", "hearing", "resolved", "appeal", "closed"],
  disciplinary: ["open", "investigation", "notice_issued", "hearing", "decision", "appeal", "closed"],
};
export const OUTCOMES: Record<string, string[]> = {
  grievance: ["upheld", "partially_upheld", "not_upheld", "withdrawn"],
  disciplinary: ["no_action", "exonerated", "verbal_warning", "written_warning", "final_warning", "suspension", "dismissal"],
};
export const EVENT_KINDS = ["note", "investigation", "hearing", "notice", "decision", "appeal"] as const;
export const CLOSED_STAGES = ["closed", "resolved"];

export async function nextCaseNo(orgId: string, type: string): Promise<string> {
  const prefix = type === "grievance" ? "GRV" : "DSC";
  const year = new Date().getFullYear();
  const n = (await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM er_case WHERE org_id=$1 AND type=$2 AND EXTRACT(YEAR FROM created_at)=$3`, [orgId, type, year]))?.c ?? 0;
  return `${prefix}-${year}-${String(n + 1).padStart(3, "0")}`;
}

export type CaseRow = {
  id: string; caseNo: string | null; type: string; employeeId: string | null; employeeName: string | null;
  counterparty: string | null; category: string | null; title: string; severity: string; confidential: boolean;
  status: string; outcome: string | null; assignedTo: string | null; openedDate: string | null; dueDate: string | null;
  closedDate: string | null; events: number;
};

export async function listCases(orgId: string, f: { type?: string; status?: string; search?: string } = {}): Promise<CaseRow[]> {
  const where: string[] = ["k.org_id=$1"];
  const params: unknown[] = [orgId];
  let n = 2;
  if (f.type) { where.push(`k.type=$${n}`); params.push(f.type); n++; }
  if (f.status === "open") where.push(`k.status NOT IN ('closed','resolved')`);
  else if (f.status === "closed") where.push(`k.status IN ('closed','resolved')`);
  if (f.search) { where.push(`(k.title ILIKE $${n} OR k.case_no ILIKE $${n})`); params.push(`%${f.search}%`); n++; }
  return q<CaseRow>(
    `SELECT k.id, k.case_no AS "caseNo", k.type, k.employee_id AS "employeeId",
            (e.first_name || ' ' || e.last_name) AS "employeeName", k.counterparty, k.category, k.title, k.severity,
            k.confidential, k.status, k.outcome, k.assigned_to AS "assignedTo", k.opened_date AS "openedDate",
            k.due_date AS "dueDate", k.closed_date AS "closedDate",
            (SELECT COUNT(*) FROM er_case_event ev WHERE ev.case_id=k.id)::int AS events
     FROM er_case k LEFT JOIN employee e ON e.id=k.employee_id
     WHERE ${where.join(" AND ")} ORDER BY k.created_at DESC LIMIT 500`, params);
}

export async function caseStats(orgId: string): Promise<{ grievanceOpen: number; disciplinaryOpen: number; overdue: number; closed: number }> {
  const r = await one<{ grievanceOpen: number; disciplinaryOpen: number; overdue: number; closed: number }>(
    `SELECT COUNT(*) FILTER (WHERE type='grievance' AND status NOT IN ('closed','resolved'))::int "grievanceOpen",
            COUNT(*) FILTER (WHERE type='disciplinary' AND status NOT IN ('closed','resolved'))::int "disciplinaryOpen",
            COUNT(*) FILTER (WHERE status NOT IN ('closed','resolved') AND due_date IS NOT NULL AND due_date < CURRENT_DATE)::int overdue,
            COUNT(*) FILTER (WHERE status IN ('closed','resolved'))::int closed
     FROM er_case WHERE org_id=$1`, [orgId]);
  return { grievanceOpen: r?.grievanceOpen ?? 0, disciplinaryOpen: r?.disciplinaryOpen ?? 0, overdue: r?.overdue ?? 0, closed: r?.closed ?? 0 };
}

export type CaseDetail = CaseRow & { description: string | null; outcomeNotes: string | null; createdByName: string | null };

export async function getCase(orgId: string, id: string): Promise<CaseDetail | null> {
  return one<CaseDetail>(
    `SELECT k.id, k.case_no AS "caseNo", k.type, k.employee_id AS "employeeId",
            (e.first_name || ' ' || e.last_name) AS "employeeName", k.counterparty, k.category, k.title, k.description, k.severity,
            k.confidential, k.status, k.outcome, k.outcome_notes AS "outcomeNotes", k.assigned_to AS "assignedTo",
            k.opened_date AS "openedDate", k.due_date AS "dueDate", k.closed_date AS "closedDate", k.created_by_name AS "createdByName",
            (SELECT COUNT(*) FROM er_case_event ev WHERE ev.case_id=k.id)::int AS events
     FROM er_case k LEFT JOIN employee e ON e.id=k.employee_id WHERE k.id=$1 AND k.org_id=$2`, [id, orgId]);
}

export type CaseEvent = {
  id: string; kind: string; summary: string | null; detail: string | null; eventDate: string | null;
  author: string | null; fileKey: string | null; fileName: string | null; createdAt: string;
};
export async function listEvents(orgId: string, caseId: string): Promise<CaseEvent[]> {
  return q<CaseEvent>(
    `SELECT id, kind, summary, detail, event_date AS "eventDate", author, file_key AS "fileKey", file_name AS "fileName", created_at AS "createdAt"
     FROM er_case_event WHERE case_id=$1 AND org_id=$2 ORDER BY COALESCE(event_date, created_at::date) DESC, created_at DESC`, [caseId, orgId]);
}
