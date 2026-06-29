import "server-only";
import { q, one } from "@/server/db";

export const ENGAGEMENT_TYPES = ["external_audit", "internal_audit", "donor_audit", "statutory_audit", "compliance_review"] as const;
export const ENGAGEMENT_STATUSES = ["planned", "fieldwork", "draft_report", "finalized", "closed"] as const;
export const FINDING_AREAS = ["Financial controls", "Procurement", "Human resources", "Governance", "Grant compliance", "Asset management", "IT / data", "Programme delivery", "Other"] as const;
export const FINDING_RISKS = ["high", "medium", "low"] as const;
export const FINDING_STATUSES = ["open", "in_progress", "implemented", "accepted_risk", "closed"] as const;
export const FINDING_RESOLVED = ["implemented", "accepted_risk", "closed"];

export type EngagementRow = {
  id: string; title: string; type: string; auditor: string | null; fiscalYear: string | null; status: string;
  reportDate: string | null; opinion: string | null; findings: number; open: number; overdue: number; highOpen: number;
};
export async function listEngagements(orgId: string, f: { status?: string; type?: string; search?: string } = {}): Promise<EngagementRow[]> {
  const where = ["e.org_id=$1"]; const params: unknown[] = [orgId]; let n = 2;
  if (f.status) { where.push(`e.status=$${n}`); params.push(f.status); n++; }
  if (f.type) { where.push(`e.type=$${n}`); params.push(f.type); n++; }
  if (f.search) { where.push(`(e.title ILIKE $${n} OR e.auditor ILIKE $${n})`); params.push(`%${f.search}%`); n++; }
  return q<EngagementRow>(
    `SELECT e.id, e.title, e.type, e.auditor, e.fiscal_year AS "fiscalYear", e.status, e.report_date AS "reportDate", e.opinion,
            (SELECT COUNT(*) FROM audit_finding x WHERE x.engagement_id=e.id)::int AS findings,
            (SELECT COUNT(*) FROM audit_finding x WHERE x.engagement_id=e.id AND x.status NOT IN ('implemented','accepted_risk','closed'))::int AS open,
            (SELECT COUNT(*) FROM audit_finding x WHERE x.engagement_id=e.id AND x.status NOT IN ('implemented','accepted_risk','closed') AND x.target_date IS NOT NULL AND x.target_date < CURRENT_DATE)::int AS overdue,
            (SELECT COUNT(*) FROM audit_finding x WHERE x.engagement_id=e.id AND x.risk='high' AND x.status NOT IN ('implemented','accepted_risk','closed'))::int AS "highOpen"
     FROM audit_engagement e WHERE ${where.join(" AND ")} ORDER BY e.created_at DESC LIMIT 500`, params);
}

export async function engagementStats(orgId: string): Promise<{ active: number; openFindings: number; highOpen: number; overdue: number }> {
  const r = await one<{ active: number; openFindings: number; highOpen: number; overdue: number }>(
    `SELECT (SELECT COUNT(*) FROM audit_engagement e WHERE e.org_id=$1 AND e.status <> 'closed')::int AS active,
            (SELECT COUNT(*) FROM audit_finding x JOIN audit_engagement e ON e.id=x.engagement_id WHERE e.org_id=$1 AND x.status NOT IN ('implemented','accepted_risk','closed'))::int AS "openFindings",
            (SELECT COUNT(*) FROM audit_finding x JOIN audit_engagement e ON e.id=x.engagement_id WHERE e.org_id=$1 AND x.risk='high' AND x.status NOT IN ('implemented','accepted_risk','closed'))::int AS "highOpen",
            (SELECT COUNT(*) FROM audit_finding x JOIN audit_engagement e ON e.id=x.engagement_id WHERE e.org_id=$1 AND x.status NOT IN ('implemented','accepted_risk','closed') AND x.target_date IS NOT NULL AND x.target_date < CURRENT_DATE)::int AS overdue`,
    [orgId]);
  return { active: r?.active ?? 0, openFindings: r?.openFindings ?? 0, highOpen: r?.highOpen ?? 0, overdue: r?.overdue ?? 0 };
}

export type EngagementDetail = {
  id: string; title: string; type: string; auditor: string | null; fiscalYear: string | null; scope: string | null;
  periodStart: string | null; periodEnd: string | null; startDate: string | null; endDate: string | null; reportDate: string | null;
  status: string; opinion: string | null; leadContact: string | null; fileKey: string | null; fileName: string | null; notes: string | null;
  total: number; implemented: number;
};
export async function getEngagement(orgId: string, id: string): Promise<EngagementDetail | null> {
  return one<EngagementDetail>(
    `SELECT e.id, e.title, e.type, e.auditor, e.fiscal_year AS "fiscalYear", e.scope, e.period_start AS "periodStart", e.period_end AS "periodEnd",
            e.start_date AS "startDate", e.end_date AS "endDate", e.report_date AS "reportDate", e.status, e.opinion, e.lead_contact AS "leadContact",
            e.file_key AS "fileKey", e.file_name AS "fileName", e.notes,
            (SELECT COUNT(*) FROM audit_finding x WHERE x.engagement_id=e.id)::int AS total,
            (SELECT COUNT(*) FROM audit_finding x WHERE x.engagement_id=e.id AND x.status IN ('implemented','accepted_risk','closed'))::int AS implemented
     FROM audit_engagement e WHERE e.id=$1 AND e.org_id=$2`, [id, orgId]);
}

export type FindingRow = {
  id: string; ref: string | null; area: string | null; title: string; risk: string; status: string;
  responsible: string | null; targetDate: string | null; overdue: boolean; updates: number;
};
export async function listFindings(orgId: string, engagementId: string): Promise<FindingRow[]> {
  return q<FindingRow>(
    `SELECT x.id, x.ref, x.area, x.title, x.risk, x.status, x.responsible, x.target_date AS "targetDate",
            (x.status NOT IN ('implemented','accepted_risk','closed') AND x.target_date IS NOT NULL AND x.target_date < CURRENT_DATE) AS overdue,
            (SELECT COUNT(*) FROM audit_finding_update u WHERE u.finding_id=x.id)::int AS updates
     FROM audit_finding x WHERE x.engagement_id=$1 AND x.org_id=$2 ORDER BY x.sort_order, x.created_at`, [engagementId, orgId]);
}

export async function nextFindingRef(engagementId: string): Promise<string> {
  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM audit_finding WHERE engagement_id=$1`, [engagementId]))?.c ?? 0;
  return `F-${String(n + 1).padStart(2, "0")}`;
}

export type FindingDetail = {
  id: string; engagementId: string; engagementTitle: string; ref: string | null; area: string | null; title: string;
  observation: string | null; risk: string; recommendation: string | null; mgmtResponse: string | null; agreedAction: string | null;
  responsible: string | null; targetDate: string | null; status: string; overdue: boolean;
};
export async function getFinding(orgId: string, id: string): Promise<FindingDetail | null> {
  return one<FindingDetail>(
    `SELECT x.id, x.engagement_id AS "engagementId", e.title AS "engagementTitle", x.ref, x.area, x.title, x.observation, x.risk,
            x.recommendation, x.mgmt_response AS "mgmtResponse", x.agreed_action AS "agreedAction", x.responsible, x.target_date AS "targetDate", x.status,
            (x.status NOT IN ('implemented','accepted_risk','closed') AND x.target_date IS NOT NULL AND x.target_date < CURRENT_DATE) AS overdue
     FROM audit_finding x JOIN audit_engagement e ON e.id=x.engagement_id WHERE x.id=$1 AND x.org_id=$2`, [id, orgId]);
}

export type FindingUpdate = { id: string; updateDate: string; note: string | null; statusAt: string | null; author: string | null; fileKey: string | null; fileName: string | null };
export async function listFindingUpdates(orgId: string, findingId: string): Promise<FindingUpdate[]> {
  return q<FindingUpdate>(
    `SELECT id, update_date AS "updateDate", note, status_at AS "statusAt", author, file_key AS "fileKey", file_name AS "fileName"
     FROM audit_finding_update WHERE finding_id=$1 AND org_id=$2 ORDER BY update_date DESC, created_at DESC`, [findingId, orgId]);
}
