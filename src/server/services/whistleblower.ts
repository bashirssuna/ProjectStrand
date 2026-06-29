import "server-only";
import { q, one } from "@/server/db";

export const WB_CATEGORIES = ["Fraud / financial misconduct", "Corruption / bribery", "Theft / misuse of assets", "Conflict of interest", "Harassment / discrimination", "Safeguarding concern", "Health & safety", "Data / confidentiality breach", "Other"] as const;
export const WB_STATUSES = ["submitted", "under_review", "investigating", "resolved", "dismissed", "closed"] as const;
export const WB_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const WB_OUTCOMES = ["substantiated", "partially_substantiated", "unsubstantiated", "no_action", "referred"] as const;
export const WB_CLOSED = ["resolved", "dismissed", "closed"];

export type ReportRow = {
  id: string; trackingCode: string; category: string | null; title: string; isAnonymous: boolean;
  severity: string; status: string; handler: string | null; retaliationConcern: boolean; createdAt: string; messages: number;
};
export async function listReports(orgId: string, f: { status?: string; search?: string } = {}): Promise<ReportRow[]> {
  const where = ["r.org_id=$1"]; const params: unknown[] = [orgId]; let n = 2;
  if (f.status === "open") where.push(`r.status NOT IN ('resolved','dismissed','closed')`);
  else if (f.status === "closed") where.push(`r.status IN ('resolved','dismissed','closed')`);
  if (f.search) { where.push(`(r.title ILIKE $${n} OR r.tracking_code ILIKE $${n})`); params.push(`%${f.search}%`); n++; }
  return q<ReportRow>(
    `SELECT r.id, r.tracking_code AS "trackingCode", r.category, r.title, r.is_anonymous AS "isAnonymous", r.severity, r.status,
            r.handler, r.retaliation_concern AS "retaliationConcern", r.created_at AS "createdAt",
            (SELECT COUNT(*) FROM whistleblower_message m WHERE m.report_id=r.id)::int AS messages
     FROM whistleblower_report r WHERE ${where.join(" AND ")} ORDER BY r.created_at DESC LIMIT 500`, params);
}

export async function reportStats(orgId: string): Promise<{ open: number; investigating: number; critical: number; closed: number }> {
  const r = await one<{ open: number; investigating: number; critical: number; closed: number }>(
    `SELECT COUNT(*) FILTER (WHERE status NOT IN ('resolved','dismissed','closed'))::int AS open,
            COUNT(*) FILTER (WHERE status='investigating')::int AS investigating,
            COUNT(*) FILTER (WHERE severity='critical' AND status NOT IN ('resolved','dismissed','closed'))::int AS critical,
            COUNT(*) FILTER (WHERE status IN ('resolved','dismissed','closed'))::int AS closed
     FROM whistleblower_report WHERE org_id=$1`, [orgId]);
  return { open: r?.open ?? 0, investigating: r?.investigating ?? 0, critical: r?.critical ?? 0, closed: r?.closed ?? 0 };
}

export type ReportDetail = {
  id: string; orgId: string; trackingCode: string; category: string | null; title: string; description: string | null;
  isAnonymous: boolean; reporterName: string | null; reporterContact: string | null; incidentDate: string | null;
  location: string | null; personsInvolved: string | null; severity: string; status: string; handler: string | null;
  retaliationConcern: boolean; outcome: string | null; outcomeNotes: string | null; createdAt: string; closedAt: string | null;
};
const DETAIL_COLS = `r.id, r.org_id AS "orgId", r.tracking_code AS "trackingCode", r.category, r.title, r.description,
  r.is_anonymous AS "isAnonymous", r.reporter_name AS "reporterName", r.reporter_contact AS "reporterContact",
  r.incident_date AS "incidentDate", r.location, r.persons_involved AS "personsInvolved", r.severity, r.status, r.handler,
  r.retaliation_concern AS "retaliationConcern", r.outcome, r.outcome_notes AS "outcomeNotes", r.created_at AS "createdAt", r.closed_at AS "closedAt"`;

export async function getReport(orgId: string, id: string): Promise<ReportDetail | null> {
  return one<ReportDetail>(`SELECT ${DETAIL_COLS} FROM whistleblower_report r WHERE r.id=$1 AND r.org_id=$2`, [id, orgId]);
}
// Public follow-up: lookup by tracking code only (the code is the access token).
export async function getReportByCode(code: string): Promise<(ReportDetail & { orgName: string }) | null> {
  return one<ReportDetail & { orgName: string }>(
    `SELECT ${DETAIL_COLS}, o.name AS "orgName" FROM whistleblower_report r JOIN organization o ON o.id=r.org_id WHERE r.tracking_code=$1`, [code]);
}

export type WbMessage = { id: string; sender: string; authorName: string | null; body: string | null; internal: boolean; fileKey: string | null; fileName: string | null; createdAt: string };
export async function listMessages(reportId: string, opts: { includeInternal: boolean }): Promise<WbMessage[]> {
  const intFilter = opts.includeInternal ? "" : "AND internal=false";
  return q<WbMessage>(
    `SELECT id, sender, author_name AS "authorName", body, internal, file_key AS "fileKey", file_name AS "fileName", created_at AS "createdAt"
     FROM whistleblower_message WHERE report_id=$1 ${intFilter} ORDER BY created_at ASC`, [reportId]);
}
