import "server-only";
import { q, one } from "@/server/db";
import { budgetLineRollups } from "@/server/services/budget";

// ---------------------------------------------------------------------------
// Project-level financial statements. These are derived from the budget lines,
// recorded expenditures, commitments, requisitions and disbursement vouchers
// that already exist in a project — no separate ledger is required. They are
// "fund accounting" style statements appropriate to a grant project:
//   • Budget vs Expenditure (variance)        — planned vs actual per line
//   • Revenue vs Expenditure (cash & accrual) — inflows vs outflows
//   • Balance Sheet (position)                — cash, receivables, payables, fund balance
//   • Cashflow Statement                      — receipts vs payments over time
// Institution-wide consolidation across projects is a separate (future) layer.
// ---------------------------------------------------------------------------

export type VarianceLine = {
  code: string; description: string; category: string; costType: string;
  planned: number; committed: number; actual: number; variance: number; pctUsed: number;
};

export type FinancialStatements = {
  currency: string;
  projectTitle: string;
  projectCode: string;
  asOf: string;
  variance: {
    lines: VarianceLine[];
    totals: { planned: number; committed: number; actual: number; variance: number; pctUsed: number };
    byCategory: { category: string; planned: number; actual: number; variance: number }[];
  };
  revVsExp: {
    // Cash basis: revenue = funds actually disbursed/received; expenditure = approved spend recorded.
    // Accrual basis: revenue = total awarded budget recognised; expenditure = actual + commitments.
    cash: { revenue: number; expenditure: number; surplus: number };
    accrual: { revenue: number; expenditure: number; surplus: number };
  };
  balanceSheet: {
    cashAndBank: number;      // grant received minus paid out
    receivables: number;      // awarded but not yet received
    totalAssets: number;
    payables: number;         // committed but not yet paid
    totalLiabilities: number;
    fundBalance: number;      // assets - liabilities
  };
  cashflow: {
    months: { month: string; receipts: number; payments: number; net: number }[];
    totalReceipts: number; totalPayments: number; netCashflow: number;
  };
};

export async function getFinancialStatements(projectId: string): Promise<FinancialStatements> {
  const proj = (await one<{ title: string; code: string; currency: string }>(
    `SELECT title, code, currency FROM project WHERE id=$1`, [projectId]
  ))!;

  const bud = await one<{ id: string }>(`SELECT id FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [projectId]);
  const rollups = bud ? await budgetLineRollups(bud.id) : [];

  const variance: VarianceLine[] = rollups.map((l) => ({
    code: l.code,
    description: l.description,
    category: l.categoryName ?? "Uncategorised",
    costType: l.costType,
    planned: l.planned,
    committed: l.committed,
    actual: l.actual,
    variance: l.planned - l.actual,
    pctUsed: l.planned > 0 ? (l.actual / l.planned) * 100 : 0,
  }));

  const tPlanned = variance.reduce((s, l) => s + l.planned, 0);
  const tCommitted = variance.reduce((s, l) => s + l.committed, 0);
  const tActual = variance.reduce((s, l) => s + l.actual, 0);

  // group by category
  const catMap = new Map<string, { planned: number; actual: number }>();
  for (const l of variance) {
    const e = catMap.get(l.category) ?? { planned: 0, actual: 0 };
    e.planned += l.planned; e.actual += l.actual; catMap.set(l.category, e);
  }
  const byCategory = [...catMap.entries()].map(([category, v]) => ({
    category, planned: v.planned, actual: v.actual, variance: v.planned - v.actual,
  })).sort((a, b) => b.planned - a.planned);

  // funds disbursed (cash out) and approved expenditure
  const disbursed = (await one<{ s: number }>(
    `SELECT COALESCE(SUM(amount),0) s FROM payment_voucher WHERE project_id=$1`, [projectId]
  ))?.s ?? 0;

  // Grant received: in this model we treat the awarded budget as the funding envelope.
  // Cash received is approximated by disbursements made + cash still held to cover recorded spend.
  // We keep it simple and defensible: revenue (accrual) = awarded budget; revenue (cash) = expenditure funded so far.
  const revenueAccrual = tPlanned;
  const expenditureAccrual = tActual + tCommitted;
  const revenueCash = tActual;          // cash basis: recognise revenue as it is spent against the grant
  const expenditureCash = tActual;

  // Cashflow by month (receipts approximated by expenditure funded; payments = vouchers, fallback expenditure)
  const payMonths = await q<{ m: string; v: number }>(
    `SELECT to_char(date_trunc('month', date), 'YYYY-MM') AS m, COALESCE(SUM(amount),0)::float v
     FROM expenditure WHERE project_id=$1
     GROUP BY date_trunc('month', date) ORDER BY date_trunc('month', date)`, [projectId]
  );
  const voucherMonths = await q<{ m: string; v: number }>(
    `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS m, COALESCE(SUM(amount),0)::float v
     FROM payment_voucher WHERE project_id=$1
     GROUP BY date_trunc('month', created_at) ORDER BY date_trunc('month', created_at)`, [projectId]
  );
  const monthKeys = [...new Set([...payMonths.map((r) => r.m), ...voucherMonths.map((r) => r.m)])].sort();
  const payByMonth = new Map(payMonths.map((r) => [r.m, r.v]));
  const recByMonth = new Map(voucherMonths.map((r) => [r.m, r.v]));
  const months = monthKeys.map((m) => {
    const payments = payByMonth.get(m) ?? 0;
    const receipts = recByMonth.get(m) ?? payments; // if no voucher data, mirror payments
    return { month: m, receipts, payments, net: receipts - payments };
  });
  const totalReceipts = months.reduce((s, r) => s + r.receipts, 0);
  const totalPayments = months.reduce((s, r) => s + r.payments, 0);

  return {
    currency: proj.currency,
    projectTitle: proj.title,
    projectCode: proj.code,
    asOf: new Date().toISOString(),
    variance: {
      lines: variance,
      totals: { planned: tPlanned, committed: tCommitted, actual: tActual, variance: tPlanned - tActual, pctUsed: tPlanned > 0 ? (tActual / tPlanned) * 100 : 0 },
      byCategory,
    },
    revVsExp: {
      cash: { revenue: revenueCash, expenditure: expenditureCash, surplus: revenueCash - expenditureCash },
      accrual: { revenue: revenueAccrual, expenditure: expenditureAccrual, surplus: revenueAccrual - expenditureAccrual },
    },
    balanceSheet: {
      cashAndBank: Math.max(0, disbursed - tActual),
      receivables: Math.max(0, tPlanned - disbursed),
      totalAssets: Math.max(0, disbursed - tActual) + Math.max(0, tPlanned - disbursed),
      payables: tCommitted,
      totalLiabilities: tCommitted,
      fundBalance: (Math.max(0, disbursed - tActual) + Math.max(0, tPlanned - disbursed)) - tCommitted,
    },
    cashflow: { months, totalReceipts, totalPayments, netCashflow: totalReceipts - totalPayments },
  };
}

// CSV serialisation for a given statement.
export function statementToCsv(fs: FinancialStatements, which: string): string {
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: (string | number)[][] = [];
  const header = `${fs.projectCode} — ${fs.projectTitle} (${fs.currency})`;

  if (which === "variance") {
    rows.push([header]); rows.push(["Budget vs Expenditure — Variance"]);
    rows.push(["Code", "Description", "Category", "Cost type", "Budget", "Committed", "Actual", "Variance", "% used"]);
    for (const l of fs.variance.lines)
      rows.push([l.code, l.description, l.category, l.costType, l.planned, l.committed, l.actual, l.variance, l.pctUsed.toFixed(1)]);
    const t = fs.variance.totals;
    rows.push(["", "TOTAL", "", "", t.planned, t.committed, t.actual, t.variance, t.pctUsed.toFixed(1)]);
  } else if (which === "revexp") {
    rows.push([header]); rows.push(["Revenue vs Expenditure"]);
    rows.push(["Basis", "Revenue", "Expenditure", "Surplus / (Deficit)"]);
    rows.push(["Cash", fs.revVsExp.cash.revenue, fs.revVsExp.cash.expenditure, fs.revVsExp.cash.surplus]);
    rows.push(["Accrual", fs.revVsExp.accrual.revenue, fs.revVsExp.accrual.expenditure, fs.revVsExp.accrual.surplus]);
  } else if (which === "balance") {
    const b = fs.balanceSheet;
    rows.push([header]); rows.push(["Balance Sheet (Statement of Financial Position)"]);
    rows.push(["Item", "Amount"]);
    rows.push(["Cash and bank", b.cashAndBank]);
    rows.push(["Grant receivable", b.receivables]);
    rows.push(["Total assets", b.totalAssets]);
    rows.push(["Payables (commitments)", b.payables]);
    rows.push(["Total liabilities", b.totalLiabilities]);
    rows.push(["Fund balance", b.fundBalance]);
  } else if (which === "cashflow") {
    rows.push([header]); rows.push(["Cashflow Statement"]);
    rows.push(["Month", "Receipts", "Payments", "Net"]);
    for (const m of fs.cashflow.months) rows.push([m.month, m.receipts, m.payments, m.net]);
    rows.push(["TOTAL", fs.cashflow.totalReceipts, fs.cashflow.totalPayments, fs.cashflow.netCashflow]);
  }
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}
