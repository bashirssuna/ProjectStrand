import "server-only";
import { q, one } from "@/server/db";

export const RECEIPT_METHODS = ["Bank transfer", "Cheque", "Cash", "Mobile money"] as const;

export type AgreementRow = {
  id: string; donor: string; title: string; reference: string | null; projectTitle: string | null; currency: string;
  totalAmount: number; received: number; outstanding: number; status: string; endDate: string | null; tranches: number;
};
export async function listAgreements(orgId: string, f: { status?: string; search?: string } = {}): Promise<AgreementRow[]> {
  const where = ["a.org_id=$1"]; const params: unknown[] = [orgId]; let n = 2;
  if (f.status === "active") where.push(`a.status='active'`);
  else if (f.status === "closed") where.push(`a.status='closed'`);
  if (f.search) { where.push(`(a.donor ILIKE $${n} OR a.title ILIKE $${n} OR a.reference ILIKE $${n})`); params.push(`%${f.search}%`); n++; }
  return q<AgreementRow>(
    `SELECT a.id, a.donor, a.title, a.reference, p.title AS "projectTitle", a.currency,
            a.total_amount::float8 AS "totalAmount",
            COALESCE((SELECT SUM(amount) FROM funding_receipt r WHERE r.agreement_id=a.id),0)::float8 AS received,
            (a.total_amount - COALESCE((SELECT SUM(amount) FROM funding_receipt r WHERE r.agreement_id=a.id),0))::float8 AS outstanding,
            a.status, a.end_date AS "endDate",
            (SELECT COUNT(*) FROM funding_tranche t WHERE t.agreement_id=a.id)::int AS tranches
     FROM funding_agreement a LEFT JOIN project p ON p.id=a.project_id
     WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC LIMIT 500`, params);
}

export type CcyMap = Record<string, number>;
export async function agreementStats(orgId: string): Promise<{ committed: CcyMap; received: CcyMap; outstanding: CcyMap; overdueAmount: CcyMap; overdueCount: number; active: number }> {
  const rows = await q<{ currency: string; committed: number; received: number }>(
    `SELECT a.currency, a.total_amount::float8 AS committed,
            COALESCE((SELECT SUM(r.amount) FROM funding_receipt r WHERE r.agreement_id=a.id),0)::float8 AS received
     FROM funding_agreement a WHERE a.org_id=$1 AND a.status='active'`, [orgId]);
  const committed: CcyMap = {}, received: CcyMap = {}, outstanding: CcyMap = {};
  for (const r of rows) {
    const c = r.currency;
    committed[c] = (committed[c] ?? 0) + r.committed;
    received[c] = (received[c] ?? 0) + r.received;
    outstanding[c] = (outstanding[c] ?? 0) + (r.committed - r.received);
  }
  const odRows = await q<{ currency: string; short: number }>(
    `SELECT a.currency, (t.amount - COALESCE((SELECT SUM(r.amount) FROM funding_receipt r WHERE r.tranche_id=t.id),0))::float8 AS short
     FROM funding_tranche t JOIN funding_agreement a ON a.id=t.agreement_id
     WHERE a.org_id=$1 AND a.status='active' AND t.expected_date IS NOT NULL AND t.expected_date < CURRENT_DATE
       AND (t.amount - COALESCE((SELECT SUM(r.amount) FROM funding_receipt r WHERE r.tranche_id=t.id),0)) > 0`, [orgId]);
  const overdueAmount: CcyMap = {}; let overdueCount = 0;
  for (const r of odRows) { const c = r.currency; overdueAmount[c] = (overdueAmount[c] ?? 0) + r.short; overdueCount++; }
  return { committed, received, outstanding, overdueAmount, overdueCount, active: rows.length };
}

export type AgreementDetail = {
  id: string; donor: string; title: string; reference: string | null; projectId: string | null; projectTitle: string | null;
  currency: string; totalAmount: number; received: number; outstanding: number; status: string;
  signedDate: string | null; startDate: string | null; endDate: string | null; focalPerson: string | null;
  fileKey: string | null; fileName: string | null; notes: string | null;
};
export async function getAgreement(orgId: string, id: string): Promise<AgreementDetail | null> {
  return one<AgreementDetail>(
    `SELECT a.id, a.donor, a.title, a.reference, a.project_id AS "projectId", p.title AS "projectTitle", a.currency,
            a.total_amount::float8 AS "totalAmount",
            COALESCE((SELECT SUM(amount) FROM funding_receipt r WHERE r.agreement_id=a.id),0)::float8 AS received,
            (a.total_amount - COALESCE((SELECT SUM(amount) FROM funding_receipt r WHERE r.agreement_id=a.id),0))::float8 AS outstanding,
            a.status, a.signed_date AS "signedDate", a.start_date AS "startDate", a.end_date AS "endDate", a.focal_person AS "focalPerson",
            a.file_key AS "fileKey", a.file_name AS "fileName", a.notes
     FROM funding_agreement a LEFT JOIN project p ON p.id=a.project_id WHERE a.id=$1 AND a.org_id=$2`, [id, orgId]);
}

export type TrancheRow = {
  id: string; label: string; expectedDate: string | null; amount: number; condition: string | null;
  received: number; outstanding: number; status: "received" | "partial" | "overdue" | "expected";
};
export async function listTranches(orgId: string, agreementId: string): Promise<TrancheRow[]> {
  const rows = await q<Omit<TrancheRow, "status" | "outstanding"> & { isPast: boolean }>(
    `SELECT t.id, t.label, t.expected_date AS "expectedDate", t.amount::float8 AS amount, t.condition,
            COALESCE((SELECT SUM(r.amount) FROM funding_receipt r WHERE r.tranche_id=t.id),0)::float8 AS received,
            (t.expected_date IS NOT NULL AND t.expected_date < CURRENT_DATE) AS "isPast"
     FROM funding_tranche t WHERE t.agreement_id=$1 AND t.org_id=$2 ORDER BY t.sort_order, t.expected_date NULLS LAST, t.created_at`, [agreementId, orgId]);
  return rows.map((t) => {
    const outstanding = Math.round((t.amount - t.received) * 100) / 100;
    let status: TrancheRow["status"];
    if (t.received >= t.amount && t.amount > 0) status = "received";
    else if (t.isPast) status = "overdue";
    else if (t.received > 0) status = "partial";
    else status = "expected";
    return { id: t.id, label: t.label, expectedDate: t.expectedDate, amount: t.amount, condition: t.condition, received: t.received, outstanding, status };
  });
}

export type Receipt = {
  id: string; receiptDate: string; amount: number; reference: string | null; method: string | null;
  trancheLabel: string | null; fileKey: string | null; fileName: string | null; notes: string | null; recordedByName: string | null;
};
export async function listReceipts(orgId: string, agreementId: string): Promise<Receipt[]> {
  return q<Receipt>(
    `SELECT r.id, r.receipt_date AS "receiptDate", r.amount::float8 AS amount, r.reference, r.method,
            t.label AS "trancheLabel", r.file_key AS "fileKey", r.file_name AS "fileName", r.notes, r.recorded_by_name AS "recordedByName"
     FROM funding_receipt r LEFT JOIN funding_tranche t ON t.id=r.tranche_id
     WHERE r.agreement_id=$1 AND r.org_id=$2 ORDER BY r.receipt_date DESC, r.created_at DESC`, [agreementId, orgId]);
}
