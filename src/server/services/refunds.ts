import "server-only";
import { q, one } from "@/server/db";

export type RefundFile = { id: string; kind: string; name: string; storageKey: string | null; mime: string | null };

export type RefundRow = {
  id: string; number: string; amount: number; reason: string | null; status: string;
  bankDetails: string | null; momoDetails: string | null;
  requestedById: string | null; requestedByName: string | null; requesterRole: string | null; requiresPi: boolean;
  expenditureId: string | null; expenditureRef: string | null; expenditurePayee: string | null; lineCode: string | null; lineDesc: string | null;
  piDecision: string | null; piByName: string | null; piAt: string | null; piComment: string | null;
  financeDecision: string | null; financeByName: string | null; financeAt: string | null; financeComment: string | null;
  paidAt: string | null; paidByName: string | null; paymentRef: string | null;
  acknowledgedAt: string | null; acknowledgedNote: string | null;
  lastRemindedAt: string | null;
  createdAt: string;
};

const COLS = `r.id, r.number, r.amount, r.reason, r.status, r.bank_details AS "bankDetails", r.momo_details AS "momoDetails",
  r.requested_by_id AS "requestedById", r.requested_by_name AS "requestedByName", r.requester_role AS "requesterRole", r.requires_pi AS "requiresPi",
  r.expenditure_id AS "expenditureId", e.reference AS "expenditureRef", e.payee AS "expenditurePayee",
  bl.code AS "lineCode", bl.description AS "lineDesc",
  r.pi_decision AS "piDecision", r.pi_by_name AS "piByName", r.pi_at AS "piAt", r.pi_comment AS "piComment",
  r.finance_decision AS "financeDecision", r.finance_by_name AS "financeByName", r.finance_at AS "financeAt", r.finance_comment AS "financeComment",
  r.paid_at AS "paidAt", r.paid_by_name AS "paidByName", r.payment_ref AS "paymentRef",
  r.acknowledged_at AS "acknowledgedAt", r.acknowledged_note AS "acknowledgedNote",
  r.last_reminded_at AS "lastRemindedAt", r.created_at AS "createdAt"`;

const FROM = `FROM refund_request r
  LEFT JOIN expenditure e ON e.id = r.expenditure_id
  LEFT JOIN budget_line bl ON bl.id = r.budget_line_id`;

export async function listRefunds(projectId: string): Promise<RefundRow[]> {
  return q<RefundRow>(`SELECT ${COLS} ${FROM} WHERE r.project_id=$1 ORDER BY r.created_at DESC`, [projectId]);
}

export async function getRefund(projectId: string, refundId: string): Promise<RefundRow | null> {
  return one<RefundRow>(`SELECT ${COLS} ${FROM} WHERE r.id=$1 AND r.project_id=$2`, [refundId, projectId]);
}

export async function refundFiles(refundId: string, kind?: string): Promise<RefundFile[]> {
  return q<RefundFile>(
    `SELECT id, kind, name, storage_key AS "storageKey", mime_type AS mime FROM refund_file
     WHERE refund_id=$1 ${kind ? "AND kind=$2" : ""} ORDER BY created_at`,
    kind ? [refundId, kind] : [refundId]
  );
}

export async function nextRefundNumber(orgId: string): Promise<string> {
  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM refund_request WHERE org_id=$1`, [orgId]))?.c ?? 0;
  return `RFD-${String(n + 1).padStart(4, "0")}`;
}

// Expenditures a refund can be raised against (all recorded spend on the project).
export type RefundableExpenditure = { id: string; amount: number; date: string; payee: string | null; reference: string | null; lineCode: string | null; lineDesc: string | null };
export async function refundableExpenditures(projectId: string): Promise<RefundableExpenditure[]> {
  return q<RefundableExpenditure>(
    `SELECT e.id, e.amount, e.date, e.payee, e.reference, bl.code AS "lineCode", bl.description AS "lineDesc"
     FROM expenditure e LEFT JOIN budget_line bl ON bl.id = e.budget_line_id
     WHERE e.project_id=$1 ORDER BY e.date DESC`, [projectId]
  );
}
