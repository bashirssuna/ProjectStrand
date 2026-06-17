import "server-only";
import { q, one } from "@/server/db";

export type ReDenomResult = {
  oldCurrency: string;
  newCurrency: string;
  rate: number;
  counts: Record<string, number>;
};

// Re-denominate ALL of a project's financial records by `rate`, optionally
// relabelling the currency to `newCurrency`.
//
// Design notes:
//  - Tables that carry their own `currency` column are guarded so that records
//    already held in a currency *other than the project's current currency* are
//    left untouched (e.g. an invoice genuinely raised in USD while the budget is
//    in UGX must not be multiplied by a UGX->USD rate). Tables without a currency
//    column (budget lines, expenditures, commitments, requisitions, vouchers) are
//    assumed to be in the project currency and are scaled unconditionally. This
//    action multiplies, so applying it twice multiplies twice — it is a one-shot
//    conversion, not idempotent.
//  - The general ledger is institution-level and balanced. We therefore scale
//    *whole entries* (every line) rather than individual lines, and only entries
//    that belong entirely to this project (every line carries this project_id).
//    Cross-project / institution-level entries are deliberately left alone, which
//    both preserves each entry's debit==credit balance and avoids re-pricing other
//    projects' figures. (For a genuine institution-wide switch, change the base
//    currency under Finance > Currency & FX rates.)
export async function reDenominateProject(
  projectId: string,
  rate: number,
  newCurrency?: string,
): Promise<ReDenomResult | null> {
  const proj = await one<{ orgId: string; currency: string }>(
    `SELECT org_id AS "orgId", currency FROM project WHERE id=$1`, [projectId]
  );
  if (!proj) return null;

  const oldCurrency = proj.currency;
  const target = (newCurrency || oldCurrency).toUpperCase();
  const counts: Record<string, number> = {};
  const upd = async (key: string, sql: string, params: unknown[]) => {
    counts[key] = (await q(sql + " RETURNING 1", params)).length;
  };

  // --- budget plan (no per-row currency: scale by project's budgets) ---
  await upd("budgetLines",
    `UPDATE budget_line SET unit_cost = unit_cost*$2, planned = planned*$2
     WHERE budget_id IN (SELECT id FROM budget WHERE project_id=$1)`, [projectId, rate]);

  // --- project actuals / requests / payments (in project currency, no guard) ---
  await upd("expenditures", `UPDATE expenditure SET amount = amount*$2 WHERE project_id=$1`, [projectId, rate]);
  await upd("commitments", `UPDATE commitment SET amount = amount*$2 WHERE project_id=$1`, [projectId, rate]);
  await upd("requisitions", `UPDATE requisition SET amount = amount*$2, disbursed_amount = disbursed_amount*$2 WHERE project_id=$1`, [projectId, rate]);
  await upd("vouchers", `UPDATE payment_voucher SET amount = amount*$2 WHERE project_id=$1`, [projectId, rate]);

  // --- income & procurement records (currency-guarded; relabel as we go) ---
  const g = [projectId, rate, target, oldCurrency];
  await upd("invoices", `UPDATE invoice SET total = total*$2, amount_paid = amount_paid*$2, currency=$3 WHERE project_id=$1 AND upper(currency)=upper($4)`, g);
  await upd("receipts", `UPDATE receipt SET amount = amount*$2, currency=$3 WHERE project_id=$1 AND upper(currency)=upper($4)`, g);
  await upd("purchaseRequests", `UPDATE purchase_request SET estimated_total = estimated_total*$2, currency=$3 WHERE project_id=$1 AND upper(currency)=upper($4)`, g);
  await upd("purchaseOrders", `UPDATE purchase_order SET total = total*$2, currency=$3 WHERE project_id=$1 AND upper(currency)=upper($4)`, g);
  await upd("vendorBills", `UPDATE vendor_bill SET total = total*$2, amount_paid = amount_paid*$2, currency=$3 WHERE project_id=$1 AND upper(currency)=upper($4)`, g);
  await upd("perdiemClaims", `UPDATE perdiem_claim SET total = total*$2, daily_rate = daily_rate*$2, currency=$3 WHERE project_id=$1 AND upper(currency)=upper($4)`, g);
  await upd("procurementPlan", `UPDATE procurement_plan_item SET est_unit_cost = est_unit_cost*$2, est_total = est_total*$2, currency=$3 WHERE project_id=$1 AND upper(currency)=upper($4)`, g);
  await upd("fixedAssets", `UPDATE fixed_asset SET cost = cost*$2, salvage_value = salvage_value*$2, accumulated_depreciation = accumulated_depreciation*$2, currency=$3 WHERE project_id=$1 AND upper(currency)=upper($4)`, g);

  // sub-award payments first (guarded by the parent award's *old* currency), then the awards
  await upd("subawardPayments", `UPDATE subaward_payment SET amount = amount*$2 WHERE subaward_id IN (SELECT id FROM subaward WHERE project_id=$1 AND upper(currency)=upper($3))`, [projectId, rate, oldCurrency]);
  await upd("subawards", `UPDATE subaward SET amount = amount*$2, currency=$3 WHERE project_id=$1 AND upper(currency)=upper($4)`, g);

  // --- general ledger: scale whole project-only entries (keeps each balanced) ---
  await upd("ledgerLines",
    `UPDATE journal_line SET debit = debit*$2, credit = credit*$2
     WHERE entry_id IN (
       SELECT je.id FROM journal_entry je
       WHERE je.org_id=$3
         AND EXISTS (SELECT 1 FROM journal_line jl WHERE jl.entry_id=je.id AND jl.project_id=$1)
         AND NOT EXISTS (SELECT 1 FROM journal_line jl WHERE jl.entry_id=je.id AND (jl.project_id IS NULL OR jl.project_id<>$1))
     )`, [projectId, rate, proj.orgId]);

  // --- currency label on the project + its budgets ---
  if (newCurrency) {
    await q(`UPDATE project SET currency=$2, updated_at=now() WHERE id=$1`, [projectId, target]);
    await q(`UPDATE budget SET currency=$2 WHERE project_id=$1`, [projectId, target]);
  }

  return { oldCurrency, newCurrency: target, rate, counts };
}
