import "server-only";
import { q, one } from "@/server/db";

export type ContractRow = {
  id: string; reference: string | null; title: string; status: string; contractValue: number; currency: string | null;
  providerName: string | null; vendorName: string | null; paid: number; milestonesTotal: number; milestonesDone: number; endDate: string | null;
};

export async function listContracts(orgId: string, f?: { status?: string; search?: string }): Promise<ContractRow[]> {
  const where: string[] = [`c.org_id=$1`];
  const params: unknown[] = [orgId];
  let n = 2;
  if (f?.status) { where.push(`c.status=$${n}`); params.push(f.status); n++; }
  if (f?.search) { where.push(`(c.title ILIKE $${n} OR c.reference ILIKE $${n} OR c.provider_name ILIKE $${n})`); params.push(`%${f.search}%`); n++; }
  return await q<ContractRow>(
    `SELECT c.id, c.reference, c.title, c.status, c.contract_value::float8 AS "contractValue", c.currency,
            c.provider_name AS "providerName", v.name AS "vendorName", c.end_date::text AS "endDate",
            COALESCE((SELECT SUM(p.amount) FROM contract_payment p WHERE p.contract_id=c.id),0)::float8 AS paid,
            COALESCE((SELECT COUNT(*) FROM contract_milestone m WHERE m.contract_id=c.id),0)::int AS "milestonesTotal",
            COALESCE((SELECT COUNT(*) FROM contract_milestone m WHERE m.contract_id=c.id AND m.status IN ('delivered','accepted')),0)::int AS "milestonesDone"
     FROM contract c LEFT JOIN vendor v ON v.id=c.vendor_id WHERE ${where.join(" AND ")} ORDER BY c.created_at DESC LIMIT 500`, params
  );
}

export type ContractStats = { total: number; active: number; completed: number; valueByCcy: Record<string, number> };
export async function contractStats(orgId: string): Promise<ContractStats> {
  const rows = await q<{ status: string; c: number }>(`SELECT status, COUNT(*)::int c FROM contract WHERE org_id=$1 GROUP BY status`, [orgId]);
  const total = rows.reduce((a, x) => a + x.c, 0);
  const active = rows.find((x) => x.status === "active")?.c ?? 0;
  const completed = rows.find((x) => x.status === "completed")?.c ?? 0;
  // Contract values can be denominated in different currencies, so they are
  // summed per-currency rather than collapsed into one (potentially meaningless) total.
  const vrows = await q<{ ccy: string | null; v: number }>(
    `SELECT currency AS ccy, COALESCE(SUM(contract_value),0)::float8 v FROM contract WHERE org_id=$1 GROUP BY currency`, [orgId]
  );
  const baseCur = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  const valueByCcy: Record<string, number> = {};
  for (const r of vrows) { const c = r.ccy || baseCur; valueByCcy[c] = (valueByCcy[c] ?? 0) + r.v; }
  return { total, active, completed, valueByCcy };
}

export type MilestoneRow = { id: string; name: string; dueDate: string | null; amount: number | null; status: string; deliveredDate: string | null; note: string | null };
export async function contractMilestones(contractId: string): Promise<MilestoneRow[]> {
  return await q<MilestoneRow>(`SELECT id, name, due_date::text AS "dueDate", amount::float8 AS amount, status, delivered_date::text AS "deliveredDate", note FROM contract_milestone WHERE contract_id=$1 ORDER BY COALESCE(due_date, delivered_date) NULLS LAST, created_at`, [contractId]);
}

export type PaymentRow = { id: string; reference: string | null; amount: number; currency: string | null; paymentDate: string | null; note: string | null };
export async function contractPayments(contractId: string): Promise<PaymentRow[]> {
  return await q<PaymentRow>(`SELECT id, reference, amount::float8 AS amount, currency, payment_date::text AS "paymentDate", note FROM contract_payment WHERE contract_id=$1 ORDER BY payment_date DESC NULLS LAST, created_at DESC`, [contractId]);
}

export type AppraisalRow = { id: string; period: string | null; quality: number | null; timeliness: number | null; compliance: number | null; comments: string | null; appraisedBy: string | null; appraisalDate: string | null };
export async function contractAppraisals(contractId: string): Promise<AppraisalRow[]> {
  return await q<AppraisalRow>(`SELECT id, period, quality::float8 AS quality, timeliness::float8 AS timeliness, compliance::float8 AS compliance, comments, appraised_by AS "appraisedBy", appraisal_date::text AS "appraisalDate" FROM contract_appraisal WHERE contract_id=$1 ORDER BY appraisal_date DESC NULLS LAST, created_at DESC`, [contractId]);
}

// Overall provider rating across appraisals (mean of the three criteria, averaged).
export function appraisalOverall(a: { quality: number | null; timeliness: number | null; compliance: number | null }): number | null {
  const vals = [a.quality, a.timeliness, a.compliance].filter((x): x is number => x != null);
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((s, x) => s + x, 0) / vals.length) * 10) / 10;
}

export async function contractPaidTotal(contractId: string): Promise<number> {
  return (await one<{ p: number }>(`SELECT COALESCE(SUM(amount),0)::float8 p FROM contract_payment WHERE contract_id=$1`, [contractId]))?.p ?? 0;
}
