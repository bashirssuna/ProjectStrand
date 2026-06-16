import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { postJournal, reverseJournal, convertToBase } from "@/server/services/ledger";

const round2 = (n: number | string) => { const x = Number(n) || 0; return Math.round((x + Number.EPSILON) * 100) / 100; };

async function nextNumber(orgId: string, table: string, prefix: string): Promise<string> {
  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ${table} WHERE org_id=$1`, [orgId]))?.c ?? 0;
  return `${prefix}-${String(n + 1).padStart(4, "0")}`;
}

// Resolve the standard accounts we post against, by code, for an org.
async function acct(orgId: string, code: string): Promise<string | null> {
  return (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code=$2`, [orgId, code]))?.id ?? null;
}

/* ----------------------------- INVOICES ----------------------------- */
// Issuing an invoice posts: debit Grants receivable (1100), credit income.
export async function issueInvoice(invoiceId: string, by: { id: string; name: string }): Promise<void> {
  const inv = await one<{
    orgId: string; projectId: string | null; number: string; invoiceDate: string; currency: string;
    incomeAccountId: string | null; total: number; status: string; description: string | null;
  }>(
    `SELECT org_id AS "orgId", project_id AS "projectId", number, invoice_date AS "invoiceDate", currency,
            income_account_id AS "incomeAccountId", total, status, description
     FROM invoice WHERE id=$1`, [invoiceId]
  );
  if (!inv || inv.status !== "draft") throw new Error("Only a draft invoice can be issued.");
  const ar = await acct(inv.orgId, "1100");
  const income = inv.incomeAccountId ?? (await acct(inv.orgId, "4000"));
  if (!ar || !income) throw new Error("Set up a Grants receivable (1100) and income account first.");

  const conv = await convertToBase(inv.orgId, Number(inv.total), inv.currency, inv.invoiceDate);
  const je = await postJournal({
    orgId: inv.orgId, entryDate: inv.invoiceDate,
    memo: `Invoice ${inv.number}${inv.description ? ` — ${inv.description}` : ""}`,
    sourceType: "manual", sourceId: invoiceId, projectId: inv.projectId,
    postedBy: by.id, postedByName: by.name,
    lines: [
      { accountId: ar, debit: conv.base, description: `Receivable — ${inv.number}` },
      { accountId: income, credit: conv.base, description: `Income — ${inv.number}` },
    ],
  });
  await q(`UPDATE invoice SET status='issued', journal_entry_id=$2 WHERE id=$1`, [invoiceId, je.entryId]);
}

export async function voidInvoice(invoiceId: string, by: { id: string; name: string }): Promise<void> {
  const inv = await one<{ orgId: string; je: string | null; amountPaid: number }>(
    `SELECT org_id AS "orgId", journal_entry_id AS je, amount_paid AS "amountPaid" FROM invoice WHERE id=$1`, [invoiceId]
  );
  if (!inv) return;
  if (inv.amountPaid > 0) throw new Error("Cannot void an invoice that has receipts against it.");
  if (inv.je) await reverseJournal(inv.orgId, inv.je, by);
  await q(`UPDATE invoice SET status='void' WHERE id=$1`, [invoiceId]);
}

/* ----------------------------- RECEIPTS ----------------------------- */
// A receipt debits cash/bank and credits either Grants receivable (if it
// settles an invoice) or an income account (for a direct receipt).
export async function recordReceipt(receiptId: string, by: { id: string; name: string }): Promise<void> {
  const r = await one<{
    orgId: string; projectId: string | null; number: string; receiptDate: string; amount: number; currency: string;
    invoiceId: string | null; depositAccountId: string | null; incomeAccountId: string | null;
  }>(
    `SELECT org_id AS "orgId", project_id AS "projectId", number, receipt_date AS "receiptDate", amount, currency,
            invoice_id AS "invoiceId", deposit_account_id AS "depositAccountId", income_account_id AS "incomeAccountId"
     FROM receipt WHERE id=$1`, [receiptId]
  );
  if (!r) throw new Error("Receipt not found.");
  const cash = r.depositAccountId ?? (await acct(r.orgId, "1000"));
  if (!cash) throw new Error("Choose a deposit (cash/bank) account.");

  const conv = await convertToBase(r.orgId, Number(r.amount), r.currency, r.receiptDate);
  // credit side: receivable if tied to an invoice, otherwise income
  const creditAcc = r.invoiceId
    ? (await acct(r.orgId, "1100"))
    : (r.incomeAccountId ?? (await acct(r.orgId, "4000")));
  if (!creditAcc) throw new Error("No receivable/income account configured.");

  const je = await postJournal({
    orgId: r.orgId, entryDate: r.receiptDate,
    memo: `Receipt ${r.number}`,
    sourceType: "manual", sourceId: receiptId, projectId: r.projectId,
    postedBy: by.id, postedByName: by.name,
    lines: [
      { accountId: cash, debit: conv.base, description: `Receipt — ${r.number}` },
      { accountId: creditAcc, credit: conv.base, description: r.invoiceId ? "Settle receivable" : "Income received" },
    ],
  });
  await q(`UPDATE receipt SET journal_entry_id=$2 WHERE id=$1`, [receiptId, je.entryId]);

  // update the invoice's paid amount / status
  if (r.invoiceId) {
    const inv = await one<{ total: number; paid: number }>(`SELECT total, amount_paid AS paid FROM invoice WHERE id=$1`, [r.invoiceId]);
    if (inv) {
      const paid = round2(Number(inv.paid) + conv.base);
      const status = paid >= inv.total ? "paid" : "part_paid";
      await q(`UPDATE invoice SET amount_paid=$2, status=$3 WHERE id=$1`, [r.invoiceId, paid, status]);
    }
  }
}

/* --------------------------- FIXED ASSETS --------------------------- */
// Acquiring an asset posts: debit asset account, credit cash/bank.
export async function postAssetAcquisition(assetId: string, by: { id: string; name: string }): Promise<void> {
  const a = await one<{
    orgId: string; projectId: string | null; name: string; acquiredOn: string; cost: number; currency: string;
    assetAccountId: string | null;
  }>(
    `SELECT org_id AS "orgId", project_id AS "projectId", name, acquired_on AS "acquiredOn", cost, currency,
            asset_account_id AS "assetAccountId" FROM fixed_asset WHERE id=$1`, [assetId]
  );
  if (!a) return;
  const assetAcc = a.assetAccountId ?? (await acct(a.orgId, "1500"));
  const cash = await acct(a.orgId, "1000");
  if (!assetAcc || !cash || Number(a.cost) <= 0) return;
  const conv = await convertToBase(a.orgId, Number(a.cost), a.currency, a.acquiredOn);
  const je = await postJournal({
    orgId: a.orgId, entryDate: a.acquiredOn, memo: `Asset acquired — ${a.name}`,
    sourceType: "manual", sourceId: assetId, projectId: a.projectId, postedBy: by.id, postedByName: by.name,
    lines: [
      { accountId: assetAcc, debit: conv.base, description: a.name },
      { accountId: cash, credit: conv.base, description: "Asset purchase" },
    ],
  });
  return void je;
}

// Straight-line monthly depreciation. Posts: debit depreciation expense,
// credit the asset account (book value reduction). One run per asset per month.
export async function runDepreciation(assetId: string, periodLabel: string, by: { id: string; name: string }): Promise<{ amount: number } | null> {
  const a = await one<{
    orgId: string; projectId: string | null; name: string; cost: number; salvage: number; life: number;
    accumulated: number; assetAccountId: string | null; expenseAccountId: string | null; currency: string;
  }>(
    `SELECT org_id AS "orgId", project_id AS "projectId", name, cost, salvage_value AS salvage,
            useful_life_months AS life, accumulated_depreciation AS accumulated,
            asset_account_id AS "assetAccountId", expense_account_id AS "expenseAccountId", currency
     FROM fixed_asset WHERE id=$1 AND status='active'`, [assetId]
  );
  if (!a) return null;
  const existing = await one<{ id: string }>(`SELECT id FROM depreciation_run WHERE asset_id=$1 AND period_label=$2`, [assetId, periodLabel]);
  if (existing) return null; // already depreciated this period

  const depreciable = Math.max(0, Number(a.cost) - Number(a.salvage));
  const monthly = round2(depreciable / Math.max(1, Number(a.life)));
  const remaining = round2(depreciable - Number(a.accumulated));
  const amount = Math.min(monthly, remaining);
  if (amount <= 0) return null;

  const expenseAcc = a.expenseAccountId ?? (await acct(a.orgId, "5300"));
  const assetAcc = a.assetAccountId ?? (await acct(a.orgId, "1500"));
  if (!expenseAcc || !assetAcc) return null;

  const je = await postJournal({
    orgId: a.orgId, entryDate: `${periodLabel}-28`, memo: `Depreciation ${periodLabel} — ${a.name}`,
    sourceType: "manual", sourceId: assetId, projectId: a.projectId, postedBy: by.id, postedByName: by.name,
    lines: [
      { accountId: expenseAcc, debit: amount, description: "Depreciation" },
      { accountId: assetAcc, credit: amount, description: "Accumulated depreciation" },
    ],
  });
  await q(`INSERT INTO depreciation_run (id, asset_id, period_label, amount, journal_entry_id) VALUES ($1,$2,$3,$4,$5)`,
    [id("dep"), assetId, periodLabel, amount, je.entryId]);
  await q(`UPDATE fixed_asset SET accumulated_depreciation = accumulated_depreciation + $2 WHERE id=$1`, [assetId, amount]);
  return { amount };
}

/* ------------------------ BANK RECONCILIATION ----------------------- */
// Reconciliation status for a bank/cash account: GL balance vs statement,
// listing unreconciled statement lines and unmatched ledger movements.
export type ReconView = {
  accountId: string; accountName: string;
  glBalance: number; statementBalance: number; difference: number;
  unreconciledLines: { id: string; date: string; description: string | null; amount: number }[];
};

export async function reconciliationView(orgId: string, accountId: string): Promise<ReconView> {
  const acc = (await one<{ name: string }>(`SELECT name FROM ledger_account WHERE id=$1 AND org_id=$2`, [accountId, orgId]))!;
  const gl = await one<{ s: number }>(
    `SELECT COALESCE(SUM(debit - credit),0)::float s FROM journal_line WHERE account_id=$1`, [accountId]
  );
  const stmt = await one<{ s: number }>(
    `SELECT COALESCE(SUM(amount),0)::float s FROM bank_statement_line WHERE account_id=$1`, [accountId]
  );
  const lines = await q<{ id: string; date: string; description: string | null; amount: number }>(
    `SELECT id, txn_date AS date, description, amount::float FROM bank_statement_line
     WHERE account_id=$1 AND reconciled=false ORDER BY txn_date`, [accountId]
  );
  const glBalance = round2(gl?.s ?? 0);
  const statementBalance = round2(stmt?.s ?? 0);
  return {
    accountId, accountName: acc.name,
    glBalance, statementBalance, difference: round2(glBalance - statementBalance),
    unreconciledLines: lines,
  };
}

// ---------------------------------------------------------------------------
// Monthly bank reconciliation. Reconciles a cash/bank GL account against the
// bank statement for one month: the book's cash movements (receipts in,
// payments/vouchers out) are listed and ticked as "cleared" when they appear on
// the statement; uncleared items become reconciling items (deposits in transit
// and outstanding payments).
// ---------------------------------------------------------------------------
export type BankRecMovement = {
  lineId: string; date: string; memo: string | null; reference: string | null; sourceType: string; amount: number; cleared: boolean;
};
export type MonthlyBankRec = {
  accountId: string; accountName: string; period: string;
  statementClosing: number | null; note: string | null; status: string;
  ledgerClosing: number;
  movements: BankRecMovement[];       // dated within the month
  broughtForward: BankRecMovement[];  // uncleared, dated before the month
  depositsInTransit: number; outstandingPayments: number;
  adjustedBank: number | null; difference: number | null;
};

export async function monthlyBankRec(orgId: string, accountId: string, period: string): Promise<MonthlyBankRec> {
  const acc = (await one<{ name: string }>(`SELECT name FROM ledger_account WHERE id=$1 AND org_id=$2`, [accountId, orgId]))!;
  const p = /^\d{4}-\d{2}$/.test(period) ? period : new Date().toISOString().slice(0, 7);
  const [y, m] = p.split("-").map(Number);
  const monthStart = `${p}-01`;
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10); // first of next month

  const rec = await one<{ statementClosing: number | null; note: string | null; status: string }>(
    `SELECT statement_closing::float AS "statementClosing", note, status FROM bank_reconciliation WHERE org_id=$1 AND account_id=$2 AND period=$3`,
    [orgId, accountId, p]
  );
  const ledger = await one<{ s: number }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit),0)::float s FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
     WHERE jl.account_id=$1 AND je.entry_date < $2::date`, [accountId, nextMonth]
  );
  const movements = await q<BankRecMovement>(
    `SELECT jl.id AS "lineId", je.entry_date AS date, je.memo, je.reference, je.source_type AS "sourceType",
            (jl.debit - jl.credit)::float AS amount, jl.cleared
     FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
     WHERE jl.account_id=$1 AND je.entry_date >= $2::date AND je.entry_date < $3::date
     ORDER BY je.entry_date, je.entry_no`, [accountId, monthStart, nextMonth]
  );
  const broughtForward = await q<BankRecMovement>(
    `SELECT jl.id AS "lineId", je.entry_date AS date, je.memo, je.reference, je.source_type AS "sourceType",
            (jl.debit - jl.credit)::float AS amount, jl.cleared
     FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
     WHERE jl.account_id=$1 AND je.entry_date < $2::date AND jl.cleared=false
     ORDER BY je.entry_date`, [accountId, monthStart]
  );
  const unc = await q<{ amount: number }>(
    `SELECT (jl.debit - jl.credit)::float AS amount FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
     WHERE jl.account_id=$1 AND je.entry_date < $2::date AND jl.cleared=false`, [accountId, nextMonth]
  );
  const depositsInTransit = round2(unc.filter((u) => u.amount > 0).reduce((s, u) => s + u.amount, 0));
  const outstandingPayments = round2(unc.filter((u) => u.amount < 0).reduce((s, u) => s - u.amount, 0));
  const ledgerClosing = round2(ledger?.s ?? 0);
  const statementClosing = rec?.statementClosing ?? null;
  const adjustedBank = statementClosing === null ? null : round2(statementClosing + depositsInTransit - outstandingPayments);
  const difference = adjustedBank === null ? null : round2(ledgerClosing - adjustedBank);
  return {
    accountId, accountName: acc.name, period: p,
    statementClosing, note: rec?.note ?? null, status: rec?.status ?? "open",
    ledgerClosing, movements, broughtForward, depositsInTransit, outstandingPayments, adjustedBank, difference,
  };
}
