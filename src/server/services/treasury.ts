import "server-only";
import { q, one } from "@/server/db";

export const RESERVE_TYPES = ["general", "capital", "contingency", "restricted", "endowment", "other"] as const;
export const RESERVE_MOVES = ["allocation", "utilization", "adjustment"] as const;
export const INSTRUMENT_TYPES = ["fixed_deposit", "treasury_bill", "bond", "money_market", "shares", "other"] as const;
export const INVESTMENT_MOVES = ["placement", "interest", "withdrawal", "maturity", "adjustment"] as const;

const RES_SIGNED = `(CASE WHEN type='utilization' THEN -amount ELSE amount END)`;
// effect on outstanding principal
const INV_SIGNED = `(CASE WHEN type IN ('withdrawal','maturity') THEN -amount WHEN type='interest' THEN 0 ELSE amount END)`;

/* ---------- Reserves ---------- */
export type FundRow = { id: string; name: string; type: string; currency: string; targetAmount: number | null; status: string; balance: number; moves: number };
export async function listFunds(orgId: string): Promise<FundRow[]> {
  return q<FundRow>(
    `SELECT f.id, f.name, f.type, f.currency, f.target_amount::float8 AS "targetAmount", f.status,
            COALESCE((SELECT SUM(${RES_SIGNED}) FROM reserve_movement m WHERE m.fund_id=f.id),0)::float8 AS balance,
            (SELECT COUNT(*) FROM reserve_movement m WHERE m.fund_id=f.id)::int AS moves
     FROM reserve_fund f WHERE f.org_id=$1 ORDER BY f.status, f.name`, [orgId]);
}
export type CcyMap = Record<string, number>;
export async function reserveStats(orgId: string): Promise<{ total: CcyMap; funds: number }> {
  const rows = await q<{ currency: string; b: number }>(
    `SELECT f.currency, COALESCE((SELECT SUM(${RES_SIGNED}) FROM reserve_movement m WHERE m.fund_id=f.id),0)::float8 AS b
     FROM reserve_fund f WHERE f.org_id=$1 AND f.status='active'`, [orgId]);
  const total: CcyMap = {};
  for (const r of rows) { const c = r.currency || "UGX"; total[c] = (total[c] ?? 0) + r.b; }
  return { total, funds: rows.length };
}
export type FundDetail = { id: string; name: string; type: string; purpose: string | null; currency: string; targetAmount: number | null; status: string; openedDate: string | null; notes: string | null; balance: number };
export async function getFund(orgId: string, id: string): Promise<FundDetail | null> {
  return one<FundDetail>(
    `SELECT f.id, f.name, f.type, f.purpose, f.currency, f.target_amount::float8 AS "targetAmount", f.status,
            f.opened_date AS "openedDate", f.notes,
            COALESCE((SELECT SUM(${RES_SIGNED}) FROM reserve_movement m WHERE m.fund_id=f.id),0)::float8 AS balance
     FROM reserve_fund f WHERE f.id=$1 AND f.org_id=$2`, [id, orgId]);
}
export async function fundBalance(orgId: string, fundId: string): Promise<number> {
  return (await one<{ b: number }>(`SELECT COALESCE(SUM(${RES_SIGNED}),0)::float8 b FROM reserve_movement WHERE fund_id=$1 AND org_id=$2`, [fundId, orgId]))?.b ?? 0;
}
export type ResMove = { id: string; movementDate: string; type: string; amount: number; signed: number; balanceAfter: number; description: string | null; reference: string | null; projectTitle: string | null; recordedByName: string | null };
export async function listFundMovements(orgId: string, fundId: string): Promise<ResMove[]> {
  const rows = await q<Omit<ResMove, "balanceAfter">>(
    `SELECT m.id, m.movement_date AS "movementDate", m.type, m.amount::float8 AS amount,
            (CASE WHEN m.type='utilization' THEN -m.amount ELSE m.amount END)::float8 AS signed,
            m.description, m.reference, p.title AS "projectTitle", m.recorded_by_name AS "recordedByName"
     FROM reserve_movement m LEFT JOIN project p ON p.id=m.project_id
     WHERE m.fund_id=$1 AND m.org_id=$2 ORDER BY m.movement_date ASC, m.created_at ASC`, [fundId, orgId]);
  let run = 0; const out = rows.map((r) => { run += r.signed; return { ...r, balanceAfter: run }; });
  out.reverse();
  return out;
}

/* ---------- Investments ---------- */
export type InvRow = {
  id: string; name: string; institution: string | null; instrumentType: string; currency: string; principal: number;
  outstanding: number; interestEarned: number; interestRate: number | null; maturityDate: string | null; status: string;
  maturityFlag: "matured_due" | "maturing_soon" | null;
};
export async function listInvestments(orgId: string): Promise<InvRow[]> {
  return q<InvRow>(
    `SELECT i.id, i.name, i.institution, i.instrument_type AS "instrumentType", i.currency, i.principal::float8 AS principal,
            (i.principal + COALESCE((SELECT SUM(${INV_SIGNED}) FROM investment_movement m WHERE m.investment_id=i.id),0))::float8 AS outstanding,
            COALESCE((SELECT SUM(amount) FROM investment_movement m WHERE m.investment_id=i.id AND m.type='interest'),0)::float8 AS "interestEarned",
            i.interest_rate::float8 AS "interestRate", i.maturity_date AS "maturityDate", i.status,
            CASE WHEN i.status='active' AND i.maturity_date IS NOT NULL AND i.maturity_date < CURRENT_DATE THEN 'matured_due'
                 WHEN i.status='active' AND i.maturity_date IS NOT NULL AND i.maturity_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'maturing_soon'
                 ELSE NULL END AS "maturityFlag"
     FROM investment i WHERE i.org_id=$1 ORDER BY i.status, i.maturity_date NULLS LAST, i.name`, [orgId]);
}
export async function investmentStats(orgId: string): Promise<{ invested: CcyMap; interestEarned: CcyMap; maturingSoon: number; maturedDue: number; active: number }> {
  const rows = await q<{ currency: string; status: string; outstanding: number; maturing: boolean; matured: boolean }>(
    `SELECT i.currency, i.status,
            (i.principal + COALESCE((SELECT SUM(${INV_SIGNED}) FROM investment_movement m WHERE m.investment_id=i.id),0))::float8 AS outstanding,
            (i.maturity_date IS NOT NULL AND i.maturity_date >= CURRENT_DATE AND i.maturity_date <= CURRENT_DATE + INTERVAL '30 days') AS maturing,
            (i.maturity_date IS NOT NULL AND i.maturity_date < CURRENT_DATE) AS matured
     FROM investment i WHERE i.org_id=$1 AND i.status='active'`, [orgId]);
  const invested: CcyMap = {}; let maturingSoon = 0, maturedDue = 0;
  for (const r of rows) {
    const c = r.currency || "UGX";
    invested[c] = (invested[c] ?? 0) + r.outstanding;
    if (r.maturing) maturingSoon++;
    if (r.matured) maturedDue++;
  }
  const intRows = await q<{ currency: string; interest: number }>(
    `SELECT i.currency, SUM(m.amount)::float8 AS interest FROM investment_movement m JOIN investment i ON i.id=m.investment_id
     WHERE i.org_id=$1 AND m.type='interest' GROUP BY i.currency`, [orgId]);
  const interestEarned: CcyMap = {};
  for (const r of intRows) interestEarned[r.currency || "UGX"] = r.interest;
  return { invested, interestEarned, maturingSoon, maturedDue, active: rows.length };
}
export type InvDetail = {
  id: string; name: string; institution: string | null; instrumentType: string; currency: string; principal: number;
  interestRate: number | null; placementDate: string | null; maturityDate: string | null; expectedValue: number | null;
  status: string; reference: string | null; notes: string | null; outstanding: number; interestEarned: number;
};
export async function getInvestment(orgId: string, id: string): Promise<InvDetail | null> {
  return one<InvDetail>(
    `SELECT i.id, i.name, i.institution, i.instrument_type AS "instrumentType", i.currency, i.principal::float8 AS principal,
            i.interest_rate::float8 AS "interestRate", i.placement_date AS "placementDate", i.maturity_date AS "maturityDate",
            i.expected_value::float8 AS "expectedValue", i.status, i.reference, i.notes,
            (i.principal + COALESCE((SELECT SUM(${INV_SIGNED}) FROM investment_movement m WHERE m.investment_id=i.id),0))::float8 AS outstanding,
            COALESCE((SELECT SUM(amount) FROM investment_movement m WHERE m.investment_id=i.id AND m.type='interest'),0)::float8 AS "interestEarned"
     FROM investment i WHERE i.id=$1 AND i.org_id=$2`, [id, orgId]);
}
export type InvMove = { id: string; movementDate: string; type: string; amount: number; description: string | null; reference: string | null; recordedByName: string | null };
export async function listInvestmentMovements(orgId: string, investmentId: string): Promise<InvMove[]> {
  return q<InvMove>(
    `SELECT id, movement_date AS "movementDate", type, amount::float8 AS amount, description, reference, recorded_by_name AS "recordedByName"
     FROM investment_movement WHERE investment_id=$1 AND org_id=$2 ORDER BY movement_date DESC, created_at DESC`, [investmentId, orgId]);
}
