import "server-only";
import { q, one } from "@/server/db";

export const EXPENSE_CATEGORIES = ["Office supplies", "Transport / fuel", "Refreshments", "Communications", "Postage / courier", "Cleaning", "Repairs", "Printing", "Sundry"] as const;
export const TXN_TYPES = ["top_up", "expense", "adjustment"] as const;
// Effect on cash on hand: expense is negative, everything else carries its stored sign.
const SIGNED = `(CASE WHEN type='expense' THEN -amount ELSE amount END)`;

export type AccountRow = {
  id: string; name: string; custodian: string | null; currency: string; floatLimit: number; status: string;
  balance: number; expensed: number; replenishDue: number; txns: number; low: boolean; projectTitle: string | null;
};
export async function listAccounts(orgId: string): Promise<AccountRow[]> {
  return q<AccountRow>(
    `SELECT a.id, a.name, a.custodian, a.currency, a.float_limit::float8 AS "floatLimit", a.status, p.title AS "projectTitle",
            COALESCE((SELECT SUM(${SIGNED}) FROM petty_cash_txn t WHERE t.account_id=a.id),0)::float8 AS balance,
            COALESCE((SELECT SUM(amount) FROM petty_cash_txn t WHERE t.account_id=a.id AND t.type='expense'),0)::float8 AS expensed,
            GREATEST(a.float_limit - COALESCE((SELECT SUM(${SIGNED}) FROM petty_cash_txn t WHERE t.account_id=a.id),0),0)::float8 AS "replenishDue",
            (SELECT COUNT(*) FROM petty_cash_txn t WHERE t.account_id=a.id)::int AS txns,
            (a.status='active' AND a.float_limit > 0 AND COALESCE((SELECT SUM(${SIGNED}) FROM petty_cash_txn t WHERE t.account_id=a.id),0) < a.float_limit * 0.2) AS low
     FROM petty_cash_account a LEFT JOIN project p ON p.id=a.project_id WHERE a.org_id=$1 ORDER BY a.status, a.name`, [orgId]);
}

export async function accountStats(orgId: string): Promise<{ totalLimit: number; onHand: number; replenishDue: number; lowCount: number; active: number }> {
  const r = await one<{ totalLimit: number; onHand: number; replenishDue: number; lowCount: number; active: number }>(
    `WITH bal AS (
       SELECT a.id, a.float_limit, a.status,
              COALESCE((SELECT SUM(${SIGNED}) FROM petty_cash_txn t WHERE t.account_id=a.id),0) AS b
       FROM petty_cash_account a WHERE a.org_id=$1
     )
     SELECT COALESCE(SUM(float_limit) FILTER (WHERE status='active'),0)::float8 AS "totalLimit",
            COALESCE(SUM(b) FILTER (WHERE status='active'),0)::float8 AS "onHand",
            COALESCE(SUM(GREATEST(float_limit-b,0)) FILTER (WHERE status='active'),0)::float8 AS "replenishDue",
            COUNT(*) FILTER (WHERE status='active' AND float_limit>0 AND b < float_limit*0.2)::int AS "lowCount",
            COUNT(*) FILTER (WHERE status='active')::int AS active
     FROM bal`, [orgId]);
  return { totalLimit: r?.totalLimit ?? 0, onHand: r?.onHand ?? 0, replenishDue: r?.replenishDue ?? 0, lowCount: r?.lowCount ?? 0, active: r?.active ?? 0 };
}

export type AccountDetail = {
  id: string; name: string; custodian: string | null; custodianEmployeeId: string | null; currency: string;
  floatLimit: number; status: string; openedDate: string | null; notes: string | null;
  balance: number; expensed: number; toppedUp: number; replenishDue: number; projectId: string | null; projectTitle: string | null;
};
export async function getAccount(orgId: string, id: string): Promise<AccountDetail | null> {
  return one<AccountDetail>(
    `SELECT a.id, a.name, a.custodian, a.custodian_employee_id AS "custodianEmployeeId", a.currency,
            a.float_limit::float8 AS "floatLimit", a.status, a.opened_date AS "openedDate", a.notes,
            a.project_id AS "projectId", p.title AS "projectTitle",
            COALESCE((SELECT SUM(${SIGNED}) FROM petty_cash_txn t WHERE t.account_id=a.id),0)::float8 AS balance,
            COALESCE((SELECT SUM(amount) FROM petty_cash_txn t WHERE t.account_id=a.id AND t.type='expense'),0)::float8 AS expensed,
            COALESCE((SELECT SUM(amount) FROM petty_cash_txn t WHERE t.account_id=a.id AND t.type='top_up'),0)::float8 AS "toppedUp",
            GREATEST(a.float_limit - COALESCE((SELECT SUM(${SIGNED}) FROM petty_cash_txn t WHERE t.account_id=a.id),0),0)::float8 AS "replenishDue"
     FROM petty_cash_account a LEFT JOIN project p ON p.id=a.project_id WHERE a.id=$1 AND a.org_id=$2`, [id, orgId]);
}

export async function balanceOf(orgId: string, accountId: string): Promise<number> {
  return (await one<{ b: number }>(`SELECT COALESCE(SUM(${SIGNED}),0)::float8 b FROM petty_cash_txn WHERE account_id=$1 AND org_id=$2`, [accountId, orgId]))?.b ?? 0;
}

export type Txn = {
  id: string; txnDate: string; type: string; amount: number; signed: number; balanceAfter: number;
  description: string | null; payee: string | null; category: string | null; reference: string | null;
  projectTitle: string | null; fileKey: string | null; fileName: string | null; approvedBy: string | null; recordedByName: string | null;
  expenditureId: string | null; budgetLineCode: string | null;
};
export async function listTxns(orgId: string, accountId: string): Promise<Txn[]> {
  const rows = await q<Omit<Txn, "balanceAfter">>(
    `SELECT t.id, t.txn_date AS "txnDate", t.type, t.amount::float8 AS amount,
            (CASE WHEN t.type='expense' THEN -t.amount ELSE t.amount END)::float8 AS signed,
            t.description, t.payee, t.category, t.reference, p.title AS "projectTitle",
            t.file_key AS "fileKey", t.file_name AS "fileName", t.approved_by AS "approvedBy", t.recorded_by_name AS "recordedByName",
            t.expenditure_id AS "expenditureId", (SELECT code FROM budget_line WHERE id=t.budget_line_id) AS "budgetLineCode"
     FROM petty_cash_txn t LEFT JOIN project p ON p.id=t.project_id
     WHERE t.account_id=$1 AND t.org_id=$2 ORDER BY t.txn_date ASC, t.created_at ASC`, [accountId, orgId]);
  let running = 0;
  const withBal = rows.map((r) => { running += r.signed; return { ...r, balanceAfter: running }; });
  withBal.reverse(); // newest first for display
  return withBal;
}
