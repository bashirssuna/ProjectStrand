import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";

// ===========================================================================
// General Ledger service. The one rule that makes double-entry trustworthy:
// every journal entry's lines must sum to zero (total debits == total credits).
// postJournal() enforces this and is the ONLY supported way to write to the
// ledger. Entries are immutable; reverseJournal() posts an offsetting entry.
// ===========================================================================

// Source systems that can post to the ledger. Extending this (over the original
// manual/expenditure/voucher/reversal/fx set) lets each module's postings be
// deduplicated and traced back to their originating document in the audit trail.
export type JournalSource =
  | "manual" | "expenditure" | "voucher" | "reversal" | "fx_revaluation"
  | "payroll" | "vendor_bill" | "vendor_payment" | "subaward" | "perdiem"
  | "petty_cash" | "funding" | "treasury" | "inventory" | "refund";

export type JournalLineInput = {
  accountId: string;
  debit?: number;
  credit?: number;
  description?: string;
  projectId?: string | null;
  currency?: string | null;     // original currency (NULL = base)
  fxAmount?: number | null;     // original foreign magnitude on this line's side
  fxRate?: number | null;       // rate used (base per foreign unit)
};

const round2 = (n: number | string) => { const x = Number(n) || 0; return Math.round((x + Number.EPSILON) * 100) / 100; };

// Posts a balanced journal entry. Throws if it doesn't balance or has no lines.
export async function postJournal(input: {
  orgId: string;
  entryDate: string;            // YYYY-MM-DD
  memo?: string;
  reference?: string | null;    // source document reference (voucher/invoice/receipt no.)
  sourceType?: JournalSource;
  sourceId?: string | null;
  projectId?: string | null;
  reversesEntryId?: string | null;
  postedBy?: string | null;
  postedByName?: string | null;
  lines: JournalLineInput[];
}): Promise<{ entryId: string; entryNo: string }> {
  const lines = input.lines.filter((l) => (Number(l.debit) || 0) !== 0 || (Number(l.credit) || 0) !== 0);
  if (lines.length < 2) throw new Error("A journal entry needs at least two lines.");

  const totalDebit = round2(lines.reduce((s, l) => s + (Number(l.debit) || 0), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + (Number(l.credit) || 0), 0));
  if (totalDebit !== totalCredit)
    throw new Error(`Journal does not balance: debits ${totalDebit} ≠ credits ${totalCredit}.`);
  if (totalDebit <= 0) throw new Error("Journal entry total must be positive.");

  // refuse to post into a closed fiscal period
  const period = await one<{ status: string }>(
    `SELECT status FROM fiscal_period WHERE org_id=$1 AND $2::date BETWEEN starts_on AND ends_on`,
    [input.orgId, input.entryDate]
  );
  if (period && period.status === "closed")
    throw new Error("That accounting period is closed — choose an open period.");

  const n = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM journal_entry WHERE org_id=$1`, [input.orgId]))?.c ?? 0;
  const entryNo = `JE-${String(n + 1).padStart(6, "0")}`;
  const entryId = id("je");

  await q(
    `INSERT INTO journal_entry (id, org_id, entry_no, entry_date, memo, reference, source_type, source_id, project_id, reverses_entry_id, posted_by, posted_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [entryId, input.orgId, entryNo, input.entryDate, input.memo ?? null, input.reference ?? null,
     input.sourceType ?? "manual", input.sourceId ?? null, input.projectId ?? null,
     input.reversesEntryId ?? null, input.postedBy ?? null, input.postedByName ?? null]
  );
  for (const l of lines) {
    await q(
      `INSERT INTO journal_line (id, entry_id, account_id, project_id, debit, credit, description, currency, fx_amount, fx_rate)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id("jl"), entryId, l.accountId, l.projectId ?? input.projectId ?? null,
       round2(l.debit ?? 0), round2(l.credit ?? 0), l.description ?? null,
       l.currency ?? null, l.fxAmount != null ? round2(l.fxAmount) : null, l.fxRate ?? null]
    );
  }
  return { entryId, entryNo };
}

// Reverses an existing entry by posting its mirror image. Idempotent-ish:
// it won't reverse the same entry twice.
export async function reverseJournal(orgId: string, entryId: string, by: { id: string; name: string }): Promise<void> {
  const existing = await one<{ id: string }>(`SELECT id FROM journal_entry WHERE reverses_entry_id=$1`, [entryId]);
  if (existing) return; // already reversed
  const head = await one<{ memo: string | null; projectId: string | null; entryNo: string }>(
    `SELECT memo, project_id AS "projectId", entry_no AS "entryNo" FROM journal_entry WHERE id=$1 AND org_id=$2`, [entryId, orgId]
  );
  if (!head) throw new Error("Entry not found.");
  const lines = await q<{ accountId: string; debit: number; credit: number; description: string | null; projectId: string | null }>(
    `SELECT account_id AS "accountId", debit, credit, description, project_id AS "projectId" FROM journal_line WHERE entry_id=$1`, [entryId]
  );
  await postJournal({
    orgId,
    entryDate: new Date().toISOString().slice(0, 10),
    memo: `Reversal of ${head.entryNo}${head.memo ? ` — ${head.memo}` : ""}`,
    sourceType: "reversal",
    reversesEntryId: entryId,
    projectId: head.projectId,
    postedBy: by.id, postedByName: by.name,
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit, description: l.description ?? undefined, projectId: l.projectId })),
  });
}

// ---------------------------------------------------------------------------
// Standard chart of accounts. Seeded once per organisation. Codes follow the
// common 1=asset, 2=liability, 3=equity, 4=income, 5=expense convention.
// ---------------------------------------------------------------------------
const STANDARD_COA: { code: string; name: string; type: string; side: string; parent?: string }[] = [
  // Assets (1xxx) — normal balance debit
  { code: "1000", name: "Cash at bank", type: "asset", side: "debit" },
  { code: "1010", name: "Cash on hand (petty cash)", type: "asset", side: "debit" },
  { code: "1100", name: "Grants receivable", type: "asset", side: "debit" },
  { code: "1200", name: "Staff advances", type: "asset", side: "debit" },
  { code: "1300", name: "Short-term investments", type: "asset", side: "debit" },
  { code: "1500", name: "Fixed assets — equipment", type: "asset", side: "debit" },
  // Liabilities (2xxx) — normal balance credit
  { code: "2000", name: "Accounts payable", type: "liability", side: "credit" },
  { code: "2100", name: "Accrued expenses", type: "liability", side: "credit" },
  { code: "2200", name: "Payroll liabilities (PAYE/NSSF)", type: "liability", side: "credit" },
  { code: "2300", name: "Deferred grant income", type: "liability", side: "credit" },
  // Equity / fund balance (3xxx) — normal balance credit
  { code: "3000", name: "Unrestricted fund balance", type: "equity", side: "credit" },
  { code: "3100", name: "Restricted fund balance", type: "equity", side: "credit" },
  // Income (4xxx) — normal balance credit
  { code: "4000", name: "Grant income", type: "income", side: "credit" },
  { code: "4100", name: "Donor contributions", type: "income", side: "credit" },
  { code: "4900", name: "Other income", type: "income", side: "credit" },
  // Expenses (5xxx) — normal balance debit
  { code: "5000", name: "Personnel & salaries", type: "expense", side: "debit" },
  { code: "5100", name: "Travel & field costs", type: "expense", side: "debit" },
  { code: "5200", name: "Supplies & consumables", type: "expense", side: "debit" },
  { code: "5300", name: "Equipment & capital", type: "expense", side: "debit" },
  { code: "5400", name: "Training & workshops", type: "expense", side: "debit" },
  { code: "5500", name: "Participant costs", type: "expense", side: "debit" },
  { code: "5900", name: "Indirect / overhead costs", type: "expense", side: "debit" },
];

export async function ensureChartOfAccounts(orgId: string): Promise<number> {
  const existing = await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ledger_account WHERE org_id=$1`, [orgId]);
  if ((existing?.c ?? 0) > 0) return existing!.c;
  for (const a of STANDARD_COA) {
    await q(
      `INSERT INTO ledger_account (id, org_id, code, name, account_type, normal_side, parent_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (org_id, code) DO NOTHING`,
      [id("acc"), orgId, a.code, a.name, a.type, a.side, a.parent ?? null]
    );
  }
  // sensible default posting rule: expenditures debit "Supplies", credit "Cash at bank".
  const cash = await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='1000'`, [orgId]);
  const exp = await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='5200'`, [orgId]);
  if (cash && exp) {
    await q(`INSERT INTO gl_posting_rule (id, org_id, rule_key, debit_account_id, credit_account_id)
             VALUES ($1,$2,'expenditure',$3,$4) ON CONFLICT (org_id, rule_key) DO NOTHING`, [id("glr"), orgId, exp.id, cash.id]);
  }
  return STANDARD_COA.length;
}

export type AccountBalance = {
  id: string; code: string; name: string; accountType: string; normalSide: string;
  debit: number; credit: number; balance: number; // balance signed per normal side
};

// Returns every account with its summed debits/credits and a normal-side balance.
export async function accountBalances(orgId: string, opts?: { from?: string; upTo?: string; projectId?: string }): Promise<AccountBalance[]> {
  const params: (string | null)[] = [orgId];
  let where = `la.org_id=$1`;
  if (opts?.from) { params.push(opts.from); where += ` AND (je.entry_date IS NULL OR je.entry_date >= $${params.length}::date)`; }
  if (opts?.upTo) { params.push(opts.upTo); where += ` AND (je.entry_date IS NULL OR je.entry_date <= $${params.length}::date)`; }
  if (opts?.projectId) { params.push(opts.projectId); where += ` AND (jl.project_id = $${params.length} OR jl.id IS NULL)`; }

  const rows = await q<AccountBalance>(
    `SELECT la.id, la.code, la.name, la.account_type AS "accountType", la.normal_side AS "normalSide",
            COALESCE(SUM(jl.debit),0)::float AS debit,
            COALESCE(SUM(jl.credit),0)::float AS credit,
            CASE WHEN la.normal_side='debit'
                 THEN COALESCE(SUM(jl.debit),0)::float - COALESCE(SUM(jl.credit),0)::float
                 ELSE COALESCE(SUM(jl.credit),0)::float - COALESCE(SUM(jl.debit),0)::float END AS balance
     FROM ledger_account la
     LEFT JOIN journal_line jl ON jl.account_id = la.id
     LEFT JOIN journal_entry je ON je.id = jl.entry_id
     WHERE ${where}
     GROUP BY la.id, la.code, la.name, la.account_type, la.normal_side
     ORDER BY la.code`,
    params
  );
  return rows;
}

export type InstitutionalStatements = {
  orgName: string;
  asOf: string;
  periodFrom: string | null;
  trialBalance: { accounts: AccountBalance[]; totalDebit: number; totalCredit: number; balanced: boolean };
  incomeStatement: { income: AccountBalance[]; expenses: AccountBalance[]; totalIncome: number; totalExpense: number; surplus: number };
  balanceSheet: { assets: AccountBalance[]; liabilities: AccountBalance[]; equity: AccountBalance[]; totalAssets: number; totalLiabilities: number; totalEquity: number; surplus: number; balanced: boolean };
};

// Institution-wide statements rolled up from the ledger. Optionally scoped to a
// date range and/or a single project. The income statement reflects activity
// within [from, to]; the balance sheet & trial balance are cumulative as-at `to`
// (a balance sheet is a snapshot, not a period movement).
export async function institutionalStatements(orgId: string, opts?: { from?: string; to?: string; projectId?: string }): Promise<InstitutionalStatements> {
  const org = (await one<{ name: string }>(`SELECT name FROM organization WHERE id=$1`, [orgId]))!;
  const to = opts?.to;
  const cumulative = await accountBalances(orgId, { upTo: to, projectId: opts?.projectId });
  const period = opts?.from ? await accountBalances(orgId, { from: opts.from, upTo: to, projectId: opts?.projectId }) : cumulative;

  // Trial balance in the standard form: each account's NET closing balance on one
  // side (not gross debit/credit turnover, which double-counts corrections and
  // reversals and makes the totals look inflated).
  const tbAccounts = cumulative
    .map((a) => {
      const net = round2(a.debit - a.credit);
      return { ...a, debit: net > 0 ? net : 0, credit: net < 0 ? round2(-net) : 0 };
    })
    .filter((a) => a.debit !== 0 || a.credit !== 0);
  const totalDebit = round2(tbAccounts.reduce((s, a) => s + a.debit, 0));
  const totalCredit = round2(tbAccounts.reduce((s, a) => s + a.credit, 0));

  const income = period.filter((a) => a.accountType === "income");
  const expenses = period.filter((a) => a.accountType === "expense");
  const totalIncome = round2(income.reduce((s, a) => s + a.balance, 0));
  const totalExpense = round2(expenses.reduce((s, a) => s + a.balance, 0));
  const surplus = round2(totalIncome - totalExpense);

  const assets = cumulative.filter((a) => a.accountType === "asset");
  const liabilities = cumulative.filter((a) => a.accountType === "liability");
  const equity = cumulative.filter((a) => a.accountType === "equity");
  const totalAssets = round2(assets.reduce((s, a) => s + a.balance, 0));
  const totalLiabilities = round2(liabilities.reduce((s, a) => s + a.balance, 0));
  const totalEquity = round2(equity.reduce((s, a) => s + a.balance, 0));

  return {
    orgName: org.name,
    asOf: to ?? new Date().toISOString().slice(0, 10),
    periodFrom: opts?.from ?? null,
    trialBalance: { accounts: tbAccounts, totalDebit, totalCredit, balanced: totalDebit === totalCredit },
    incomeStatement: { income, expenses, totalIncome, totalExpense, surplus },
    // Assets = Liabilities + Equity + net surplus (current-year result not yet closed to equity)
    balanceSheet: { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, surplus, balanced: round2(totalAssets) === round2(totalLiabilities + totalEquity + surplus) },
  };
}

export type LedgerTxn = { id: string; date: string; entryNo: string; memo: string | null; sourceType: string; description: string | null; projectId: string | null; projectCode: string | null; debit: number; credit: number; running: number };

// The detailed transaction list (general-ledger detail) for one account, with a
// running normal-side balance carried from the opening balance before `from`.
export async function accountTransactions(orgId: string, accountId: string, opts?: { from?: string; to?: string; projectId?: string }): Promise<{
  account: { code: string; name: string; accountType: string; normalSide: string } | null;
  opening: number; lines: LedgerTxn[]; totalDebit: number; totalCredit: number; closing: number;
}> {
  const account = await one<{ code: string; name: string; accountType: string; normalSide: string }>(
    `SELECT code, name, account_type AS "accountType", normal_side AS "normalSide" FROM ledger_account WHERE id=$1 AND org_id=$2`, [accountId, orgId]
  );
  if (!account) return { account: null, opening: 0, lines: [], totalDebit: 0, totalCredit: 0, closing: 0 };
  const sign = account.normalSide === "debit" ? 1 : -1;

  // Opening balance = net (debit-credit) strictly before `from`, signed by normal side.
  let opening = 0;
  if (opts?.from) {
    const p: (string | null)[] = [accountId, opts.from];
    let w = `jl.account_id=$1 AND je.entry_date < $2::date`;
    if (opts.projectId) { p.push(opts.projectId); w += ` AND jl.project_id=$${p.length}`; }
    const o = await one<{ s: number }>(`SELECT COALESCE(SUM(jl.debit-jl.credit),0)::float s FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id WHERE ${w}`, p);
    opening = round2((o?.s ?? 0) * sign);
  }

  const p: (string | null)[] = [accountId];
  let w = `jl.account_id=$1`;
  if (opts?.from) { p.push(opts.from); w += ` AND je.entry_date >= $${p.length}::date`; }
  if (opts?.to) { p.push(opts.to); w += ` AND je.entry_date <= $${p.length}::date`; }
  if (opts?.projectId) { p.push(opts.projectId); w += ` AND jl.project_id=$${p.length}`; }
  const rows = await q<Omit<LedgerTxn, "running">>(
    `SELECT jl.id, to_char(je.entry_date, 'YYYY-MM-DD') AS date, je.entry_no AS "entryNo", je.memo, je.source_type AS "sourceType",
            jl.description, jl.project_id AS "projectId", pr.code AS "projectCode",
            jl.debit::float AS debit, jl.credit::float AS credit
     FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
     LEFT JOIN project pr ON pr.id = jl.project_id
     WHERE ${w} ORDER BY je.entry_date, je.entry_no, jl.id`, p
  );
  let running = opening;
  const lines: LedgerTxn[] = rows.map((r) => { running = round2(running + (r.debit - r.credit) * sign); return { ...r, running }; });
  const totalDebit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredit = round2(rows.reduce((s, r) => s + r.credit, 0));
  return { account, opening, lines, totalDebit, totalCredit, closing: running };
}

// Posts the journal for a recorded expenditure, using the org's posting rule
// (debit expense account, credit cash/bank). Maps the budget line's category to
// a sensible expense account when possible. No-op if no chart of accounts yet.
// APPROVAL GATE: only approved expenditures reach the ledger. Draft spend and
// reimbursement claims awaiting a decision stay out of the books entirely; they
// post when the record (or its refund request) is finally approved.
export async function postExpenditureToLedger(input: {
  orgId: string; projectId: string; expenditureId: string; amount: number; date: string;
  reference?: string | null; payee?: string | null; postedBy?: string | null; postedByName?: string | null;
  force?: boolean; // skip the duplicate check — caller has just reversed the old entry (edit flow)
}): Promise<void> {
  const haveCoa = await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ledger_account WHERE org_id=$1`, [input.orgId]);
  if (!haveCoa || haveCoa.c === 0) return; // ledger not enabled for this org
  const row = await one<{ approved: boolean }>(`SELECT approved FROM expenditure WHERE id=$1`, [input.expenditureId]);
  if (!row?.approved) return; // not (yet) approved — nothing goes to the books
  // Don't double-post: skip if an ACTIVE (not-reversed) entry already exists for this
  // expenditure. Reversed entries don't count — a record reversed on edit/un-approval
  // can be posted again once it is approved.
  if (!input.force) {
    const dup = await one<{ id: string }>(
      `SELECT je.id FROM journal_entry je
       WHERE je.source_type='expenditure' AND je.source_id=$1 AND je.reverses_entry_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.reverses_entry_id=je.id)`, [input.expenditureId]);
    if (dup) return;
  }

  const rule = await one<{ debit: string | null; credit: string | null }>(
    `SELECT debit_account_id AS debit, credit_account_id AS credit FROM gl_posting_rule WHERE org_id=$1 AND rule_key='expenditure'`, [input.orgId]
  );
  let debitAcc = rule?.debit ?? null;
  const creditAcc = rule?.credit ?? (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='1000'`, [input.orgId]))?.id ?? null;
  if (!debitAcc) debitAcc = (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='5200'`, [input.orgId]))?.id ?? null;
  if (!debitAcc || !creditAcc) return;

  // Grant/NGO fund accounting: as restricted grant funds are spent, recognise
  // matching grant income so the income statement balances (income = funds used,
  // not a phantom deficit). If a grant-income account (4000) exists we add the
  // funding side to the same entry: grant received into cash + income recognised.
  const grantIncomeAcc = (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='4000'`, [input.orgId]))?.id ?? null;
  const lines = [
    { accountId: debitAcc, debit: input.amount, description: "Expenditure", projectId: input.projectId },
    { accountId: creditAcc, credit: input.amount, description: "Cash/bank", projectId: input.projectId },
  ];
  if (grantIncomeAcc) {
    lines.push({ accountId: creditAcc, debit: input.amount, description: "Grant funds applied", projectId: input.projectId });
    lines.push({ accountId: grantIncomeAcc, credit: input.amount, description: "Grant income recognised", projectId: input.projectId });
  }

  await postJournal({
    orgId: input.orgId,
    entryDate: input.date.slice(0, 10),
    memo: `Expenditure${input.reference ? ` ${input.reference}` : ""}${input.payee ? ` — ${input.payee}` : ""}`,
    reference: input.reference ?? null,
    sourceType: "expenditure",
    sourceId: input.expenditureId,
    projectId: input.projectId,
    postedBy: input.postedBy, postedByName: input.postedByName,
    lines,
  });
}

// A reimbursement that finance has approved is real spend. Refunds LINKED to a
// recorded expenditure approve & post that expenditure instead (see the refund
// actions); STANDALONE reimbursements have no expenditure row, so they post their
// own grant-model entry here (Dr expense, Cr cash, Dr cash, Cr grant income).
// Idempotent per refund: skips when an active entry already exists.
export async function postRefundToLedger(input: {
  orgId: string; projectId: string; refundId: string; number: string; amount: number;
  payee?: string | null; postedBy?: string | null; postedByName?: string | null;
}): Promise<void> {
  const haveCoa = await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ledger_account WHERE org_id=$1`, [input.orgId]);
  if (!haveCoa || haveCoa.c === 0) return;
  if (!(input.amount > 0)) return;
  const dup = await one<{ id: string }>(
    `SELECT je.id FROM journal_entry je
     WHERE je.source_type='refund' AND je.source_id=$1 AND je.reverses_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.reverses_entry_id=je.id)`, [input.refundId]);
  if (dup) return;
  const rule = await one<{ debit: string | null; credit: string | null }>(
    `SELECT debit_account_id AS debit, credit_account_id AS credit FROM gl_posting_rule WHERE org_id=$1 AND rule_key='expenditure'`, [input.orgId]);
  const debitAcc = rule?.debit ?? (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='5200'`, [input.orgId]))?.id ?? null;
  const creditAcc = rule?.credit ?? (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='1000'`, [input.orgId]))?.id ?? null;
  if (!debitAcc || !creditAcc) return;
  const grantIncomeAcc = (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='4000'`, [input.orgId]))?.id ?? null;
  const lines: JournalLineInput[] = [
    { accountId: debitAcc, debit: input.amount, description: "Reimbursement", projectId: input.projectId },
    { accountId: creditAcc, credit: input.amount, description: "Cash/bank", projectId: input.projectId },
  ];
  if (grantIncomeAcc) {
    lines.push({ accountId: creditAcc, debit: input.amount, description: "Grant funds applied", projectId: input.projectId });
    lines.push({ accountId: grantIncomeAcc, credit: input.amount, description: "Grant income recognised", projectId: input.projectId });
  }
  await postJournal({
    orgId: input.orgId,
    entryDate: new Date().toISOString().slice(0, 10),
    memo: `Reimbursement ${input.number}${input.payee ? ` — ${input.payee}` : ""}`,
    reference: input.number,
    sourceType: "refund",
    sourceId: input.refundId,
    projectId: input.projectId,
    postedBy: input.postedBy, postedByName: input.postedByName,
    lines,
  });
}

// Recognises institutional overhead (indirect-cost recovery) the moment a project
// budget is approved: the sum of the budget's indirect-cost lines is posted as
// income (Dr Grants receivable, Cr Grant income) and thereby "moves" out of the
// project's spendable budget into the institution's revenue. Idempotent per budget.
export async function recognizeIndirectRecovery(orgId: string, projectId: string, budgetId: string, by: { id: string; name: string }): Promise<number> {
  const haveCoa = await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ledger_account WHERE org_id=$1`, [orgId]);
  if (!haveCoa || haveCoa.c === 0) return 0;
  const reference = `IDC-${budgetId}`;
  const dup = await one<{ id: string }>(`SELECT id FROM journal_entry WHERE org_id=$1 AND reference=$2`, [orgId, reference]);
  if (dup) return 0; // already recognised for this budget
  const sum = await one<{ t: number }>(
    `SELECT COALESCE(SUM(bl.planned),0)::float t FROM budget_line bl JOIN budget_category bc ON bc.id=bl.category_id
     WHERE bl.budget_id=$1 AND bc.cost_type='indirect'`, [budgetId]);
  const amount = round2(sum?.t ?? 0);
  if (!(amount > 0)) return 0;
  const receivable = (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='1100'`, [orgId]))?.id ?? null;
  const income = (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='4000'`, [orgId]))?.id ?? null;
  if (!receivable || !income) return 0;
  const proj = await one<{ code: string }>(`SELECT code FROM project WHERE id=$1`, [projectId]);
  await postJournal({
    orgId, entryDate: new Date().toISOString().slice(0, 10),
    memo: `Indirect cost recovery — ${proj?.code ?? "project"}`,
    reference, sourceType: "manual", sourceId: budgetId, projectId,
    postedBy: by.id, postedByName: by.name,
    lines: [
      { accountId: receivable, debit: amount, description: "Indirect cost recovery (receivable)", projectId },
      { accountId: income, credit: amount, description: "Indirect cost recovery (income)", projectId },
    ],
  });
  // Deduct the overhead from the project budget so the project's remaining reflects
  // only its direct costs (idempotent; see deductIndirectFromBudget).
  await deductIndirectFromBudget(projectId, budgetId, by);
  return amount;
}

// Consume each indirect budget line as an OVERHEAD-XFER expenditure — the overhead is
// "transferred to the institution" at budget approval, so the project cannot spend it.
// These rows carry the OVERHEAD-XFER marker and are NOT posted to the ledger (the
// IDC income entry is the institutional side). Idempotent per line: it tops up to
// (planned − real spend) and never double-counts an existing transfer. Returns the
// number of lines it created a transfer for.
export async function deductIndirectFromBudget(projectId: string, budgetId: string, by: { id: string; name: string }): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const indLines = await q<{ id: string; planned: number; spent: number; xfer: number }>(
    `SELECT bl.id, bl.planned::float AS planned,
            COALESCE((SELECT SUM(amount) FROM expenditure WHERE budget_line_id=bl.id AND COALESCE(reference,'')<>'OVERHEAD-XFER'),0)::float AS spent,
            COALESCE((SELECT SUM(amount) FROM expenditure WHERE budget_line_id=bl.id AND COALESCE(reference,'')='OVERHEAD-XFER'),0)::float AS xfer
     FROM budget_line bl JOIN budget_category bc ON bc.id=bl.category_id
     WHERE bl.budget_id=$1 AND bc.cost_type='indirect'`, [budgetId]);
  let n = 0;
  for (const bl of indLines) {
    const target = round2(bl.planned - bl.spent);   // overhead to move to the institution
    const deduct = round2(target - bl.xfer);         // minus what's already been moved
    if (deduct > 0) {
      await q(`INSERT INTO expenditure (id, project_id, budget_line_id, amount, date, reference, payee, approved, created_by_id)
               VALUES ($1,$2,$3,$4,$5,'OVERHEAD-XFER','Institution (indirect cost recovery)',true,$6)`,
        [id("exp"), projectId, bl.id, deduct, today, by.id]);
      n++;
    }
  }
  return n;
}

// Reverses every not-yet-reversed general-ledger entry posted for an expenditure.
// Used when an expenditure is edited (before re-posting) or deleted, so the ledger
// stays consistent with the corrected/removed spend. No-op if the ledger is off.
export async function reverseExpenditureJournals(orgId: string, expenditureId: string, by: { id: string; name: string }): Promise<void> {
  const entries = await q<{ id: string }>(
    `SELECT je.id FROM journal_entry je
     WHERE je.org_id=$1 AND je.source_type='expenditure' AND je.source_id=$2
       AND NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.reverses_entry_id=je.id)`,
    [orgId, expenditureId]
  );
  for (const e of entries) await reverseJournal(orgId, e.id, by);
}

// One-time reconciliation for data posted before grant-income / overhead
// recognition was enabled: (a) recognise overhead on every already-approved budget
// that lacks it, and (b) upgrade legacy 2-line expenditure entries so grant income
// is recognised against them. Idempotent — safe to run repeatedly.
export async function reconcileLedger(orgId: string, by: { id: string; name: string }): Promise<{ overheadPosted: number; expendituresFixed: number; unapprovedCleared: number }> {
  const haveCoa = await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ledger_account WHERE org_id=$1`, [orgId]);
  if (!haveCoa || haveCoa.c === 0) return { overheadPosted: 0, expendituresFixed: 0, unapprovedCleared: 0 };

  // (a) overhead for approved budgets not yet recognised
  let overheadPosted = 0;
  const approved = await q<{ budgetId: string; projectId: string }>(
    `SELECT b.id AS "budgetId", b.project_id AS "projectId" FROM budget b
     WHERE b.status='approved' AND b.project_id IN (SELECT id FROM project WHERE org_id=$1)
       AND NOT EXISTS (SELECT 1 FROM journal_entry je WHERE je.org_id=$1 AND je.reference='IDC-'||b.id)`, [orgId]);
  for (const a of approved) { if ((await recognizeIndirectRecovery(orgId, a.projectId, a.budgetId, by)) > 0) overheadPosted++; }

  // (a2) ensure the indirect deduction exists for EVERY approved budget, including
  //      budgets whose overhead income was recognised before deduction was enabled
  //      (those are skipped by the dup guard in recognizeIndirectRecovery above).
  const allApproved = await q<{ budgetId: string; projectId: string }>(
    `SELECT b.id AS "budgetId", b.project_id AS "projectId" FROM budget b
     WHERE b.status='approved' AND b.project_id IN (SELECT id FROM project WHERE org_id=$1)`, [orgId]);
  for (const a of allApproved) { await deductIndirectFromBudget(a.projectId, a.budgetId, by); }

  // (b) any project expenditure that lacks a correct (active, grant-income-bearing)
  //     ledger entry — legacy 2-line entries, never-posted spend, or an entry left
  //     reversed by an interrupted run. Excludes overhead-transfer rows (no ledger by
  //     design) and voucher-paid rows (the voucher posted their entry).
  let expendituresFixed = 0;
  const toFix = await q<{ expenditureId: string; projectId: string; amount: number; date: string; reference: string | null; payee: string | null }>(
    `SELECT e.id AS "expenditureId", e.project_id AS "projectId", e.amount::float AS amount,
            to_char(e.date, 'YYYY-MM-DD') AS date, e.reference, e.payee
     FROM expenditure e
     JOIN project p ON p.id=e.project_id AND p.org_id=$1
     WHERE e.approved = true
       AND COALESCE(e.reference,'') <> 'OVERHEAD-XFER'
       AND e.budget_line_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM payment_voucher pv WHERE pv.expenditure_id=e.id)
       AND NOT EXISTS (
         SELECT 1 FROM journal_entry je
         WHERE je.source_type='expenditure' AND je.source_id=e.id AND je.reverses_entry_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.reverses_entry_id=je.id)
           AND EXISTS (SELECT 1 FROM journal_line jl JOIN ledger_account la ON la.id=jl.account_id WHERE jl.entry_id=je.id AND la.code='4000')
       )`, [orgId]);
  for (const e of toFix) {
    if (!e.projectId) continue;
    await reverseExpenditureJournals(orgId, e.expenditureId, by); // clear any stale/legacy entry
    await postExpenditureToLedger({ orgId, projectId: e.projectId, expenditureId: e.expenditureId, amount: e.amount,
      date: e.date, reference: e.reference, payee: e.payee, postedBy: by.id, postedByName: by.name, force: true });
    expendituresFixed++;
  }

  // (c) pull UNAPPROVED spend back out of the books: draft expenditures and
  //     reimbursement claims still awaiting a decision must not appear in the
  //     ledger; reverse any active entry they left behind (posted before the
  //     approval gate existed). Also clears entries whose expenditure was deleted.
  let unapprovedCleared = 0;
  const toClear = await q<{ expenditureId: string }>(
    `SELECT DISTINCT je.source_id AS "expenditureId"
     FROM journal_entry je
     WHERE je.org_id=$1 AND je.source_type='expenditure' AND je.reverses_entry_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.reverses_entry_id=je.id)
       AND NOT EXISTS (SELECT 1 FROM expenditure e WHERE e.id=je.source_id AND e.approved=true)`, [orgId]);
  for (const e of toClear) {
    await reverseExpenditureJournals(orgId, e.expenditureId, by);
    unapprovedCleared++;
  }
  return { overheadPosted, expendituresFixed, unapprovedCleared };
}

// Auto-archive settled general-journal entries older than `months` (default 12) so the
// journal view stays tidy. Purely presentational — archived entries still post to every
// financial statement and balance. Idempotent (skips already-archived rows). With no
// orgId it archives across all organisations (used by the scheduled cron).
export async function autoArchiveOldJournals(opts?: { orgId?: string; months?: number }): Promise<number> {
  const months = Math.max(1, Math.floor(opts?.months ?? 12));
  const params: unknown[] = [months];
  let where = `archived = false AND entry_date < (CURRENT_DATE - ($1::int * INTERVAL '1 month'))`;
  if (opts?.orgId) { params.push(opts.orgId); where += ` AND org_id = $${params.length}`; }
  const res = await q<{ id: string }>(
    `UPDATE journal_entry SET archived = true, archived_at = now() WHERE ${where} RETURNING id`, params);
  return res.length;
}

// ===========================================================================
// Module posting hooks. Each is a no-op until the org has a chart of accounts
// (ensureChartOfAccounts), and each de-duplicates by (source_type, source_id)
// so retries/re-saves never double-post. Amounts are converted to the org's
// base/reporting currency before posting. These implement the finance links
// that were previously deferred (payroll, vendor bills, sub-awards, per-diem,
// petty cash, treasury, funding).
// ===========================================================================

async function acctCode(orgId: string, code: string): Promise<string | null> {
  return (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code=$2`, [orgId, code]))?.id ?? null;
}
async function ledgerEnabled(orgId: string): Promise<boolean> {
  const c = await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ledger_account WHERE org_id=$1`, [orgId]);
  return !!c && c.c > 0;
}
async function alreadyPosted(sourceType: JournalSource, sourceId: string): Promise<boolean> {
  return !!(await one<{ id: string }>(`SELECT id FROM journal_entry WHERE source_type=$1 AND source_id=$2`, [sourceType, sourceId]));
}

// Generic cash payment: DR an expense account, CR cash/bank. Project-tagged.
export async function postCashPayment(input: {
  orgId: string; date: string; amount: number; currency?: string | null;
  expenseCode?: string; expenseAccountId?: string | null; cashCode?: string;
  projectId?: string | null; memo?: string; reference?: string | null;
  sourceType: JournalSource; sourceId: string; postedBy?: string | null; postedByName?: string | null;
}): Promise<string | null> {
  if (!(await ledgerEnabled(input.orgId))) return null;
  if (!(input.amount > 0)) return null;
  if (await alreadyPosted(input.sourceType, input.sourceId)) return null;
  const expense = input.expenseAccountId ?? (await acctCode(input.orgId, input.expenseCode ?? "5200"));
  const cash = await acctCode(input.orgId, input.cashCode ?? "1000");
  if (!expense || !cash) return null;
  const conv = await convertToBase(input.orgId, input.amount, input.currency ?? "", input.date.slice(0, 10));
  const je = await postJournal({
    orgId: input.orgId, entryDate: input.date.slice(0, 10), memo: input.memo, reference: input.reference ?? null,
    sourceType: input.sourceType, sourceId: input.sourceId, projectId: input.projectId ?? null,
    postedBy: input.postedBy, postedByName: input.postedByName,
    lines: [
      { accountId: expense, debit: conv.base, description: input.memo ?? "Payment", projectId: input.projectId ?? null },
      { accountId: cash, credit: conv.base, description: "Cash/bank", projectId: input.projectId ?? null },
    ],
  });
  return je.entryId;
}

// Generic cash receipt: DR cash/bank, CR an income account. Project-tagged.
export async function postCashReceipt(input: {
  orgId: string; date: string; amount: number; currency?: string | null;
  incomeCode?: string; incomeAccountId?: string | null; cashCode?: string;
  projectId?: string | null; memo?: string; reference?: string | null;
  sourceType: JournalSource; sourceId: string; postedBy?: string | null; postedByName?: string | null;
}): Promise<string | null> {
  if (!(await ledgerEnabled(input.orgId))) return null;
  if (!(input.amount > 0)) return null;
  if (await alreadyPosted(input.sourceType, input.sourceId)) return null;
  const income = input.incomeAccountId ?? (await acctCode(input.orgId, input.incomeCode ?? "4000"));
  const cash = await acctCode(input.orgId, input.cashCode ?? "1000");
  if (!income || !cash) return null;
  const conv = await convertToBase(input.orgId, input.amount, input.currency ?? "", input.date.slice(0, 10));
  const je = await postJournal({
    orgId: input.orgId, entryDate: input.date.slice(0, 10), memo: input.memo, reference: input.reference ?? null,
    sourceType: input.sourceType, sourceId: input.sourceId, projectId: input.projectId ?? null,
    postedBy: input.postedBy, postedByName: input.postedByName,
    lines: [
      { accountId: cash, debit: conv.base, description: "Cash/bank", projectId: input.projectId ?? null },
      { accountId: income, credit: conv.base, description: input.memo ?? "Receipt", projectId: input.projectId ?? null },
    ],
  });
  return je.entryId;
}

// Generic transfer between two asset accounts (e.g. bank 1000 → petty cash 1010).
export async function postFundsTransfer(input: {
  orgId: string; date: string; amount: number; currency?: string | null;
  fromCode: string; toCode: string; memo?: string;
  sourceType: JournalSource; sourceId: string; postedBy?: string | null; postedByName?: string | null;
}): Promise<string | null> {
  if (!(await ledgerEnabled(input.orgId))) return null;
  if (!(input.amount > 0)) return null;
  if (await alreadyPosted(input.sourceType, input.sourceId)) return null;
  const from = await acctCode(input.orgId, input.fromCode);
  const to = await acctCode(input.orgId, input.toCode);
  if (!from || !to) return null;
  const conv = await convertToBase(input.orgId, input.amount, input.currency ?? "", input.date.slice(0, 10));
  const je = await postJournal({
    orgId: input.orgId, entryDate: input.date.slice(0, 10), memo: input.memo,
    sourceType: input.sourceType, sourceId: input.sourceId,
    postedBy: input.postedBy, postedByName: input.postedByName,
    lines: [
      { accountId: to, debit: conv.base, description: input.memo ?? "Transfer in" },
      { accountId: from, credit: conv.base, description: input.memo ?? "Transfer out" },
    ],
  });
  return je.entryId;
}

// Payroll run: DR Personnel & salaries (5000)=gross; CR Payroll liabilities
// (2200)=deductions; CR Cash at bank (1000)=net. If no liability account exists,
// the whole gross is credited to cash. No-op if the ledger isn't set up or the
// run has already been posted. Assumption: all deductions are treated as a single
// statutory/other payroll liability — split further if you track PAYE/NSSF apart.
export async function postPayrollToLedger(input: {
  orgId: string; runId: string; postedBy?: string | null; postedByName?: string | null;
}): Promise<void> {
  if (!(await ledgerEnabled(input.orgId))) return;
  const run = await one<{ gross: number; deductions: number; net: number; date: string; period: string | null; je: string | null }>(
    `SELECT total_gross::float AS gross, total_deductions::float AS deductions, total_net::float AS net,
            run_date AS date, period_label AS period, journal_entry_id AS je
       FROM payroll_run WHERE id=$1 AND org_id=$2`, [input.runId, input.orgId]);
  if (!run || run.je || !(run.gross > 0)) return;
  const salaries = await acctCode(input.orgId, "5000");
  const cash = await acctCode(input.orgId, "1000");
  const payLiab = await acctCode(input.orgId, "2200");
  if (!salaries || !cash) return;
  const lines: JournalLineInput[] = [{ accountId: salaries, debit: run.gross, description: "Gross salaries" }];
  if (run.deductions > 0 && payLiab) {
    lines.push({ accountId: payLiab, credit: run.deductions, description: "Statutory & other deductions" });
    lines.push({ accountId: cash, credit: run.net, description: "Net pay" });
  } else {
    lines.push({ accountId: cash, credit: run.gross, description: "Net pay" });
  }
  const je = await postJournal({
    orgId: input.orgId, entryDate: run.date, memo: `Payroll ${run.period ?? ""}`.trim(),
    sourceType: "payroll", sourceId: input.runId,
    postedBy: input.postedBy, postedByName: input.postedByName, lines,
  });
  await q(`UPDATE payroll_run SET journal_entry_id=$2 WHERE id=$1`, [input.runId, je.entryId]);
}

// Vendor bill (accounts payable recognition): DR expense (the bill's
// expense_account_id, else Supplies 5200), CR Accounts payable (2000).
export async function postVendorBillToLedger(input: {
  orgId: string; billId: string; postedBy?: string | null; postedByName?: string | null;
}): Promise<void> {
  if (!(await ledgerEnabled(input.orgId))) return;
  const bill = await one<{ projectId: string | null; total: number; currency: string; date: string; expenseAcct: string | null; number: string; je: string | null }>(
    `SELECT project_id AS "projectId", total::float AS total, currency, bill_date AS date,
            expense_account_id AS "expenseAcct", number, journal_entry_id AS je
       FROM vendor_bill WHERE id=$1 AND org_id=$2`, [input.billId, input.orgId]);
  if (!bill || bill.je || !(bill.total > 0)) return;
  const ap = await acctCode(input.orgId, "2000");
  const expense = bill.expenseAcct ?? (await acctCode(input.orgId, "5200"));
  if (!ap || !expense) return;
  const conv = await convertToBase(input.orgId, bill.total, bill.currency, bill.date);
  const je = await postJournal({
    orgId: input.orgId, entryDate: bill.date, memo: `Vendor bill ${bill.number}`, reference: bill.number,
    sourceType: "vendor_bill", sourceId: input.billId, projectId: bill.projectId,
    postedBy: input.postedBy, postedByName: input.postedByName,
    lines: [
      { accountId: expense, debit: conv.base, description: `Expense — ${bill.number}`, projectId: bill.projectId },
      { accountId: ap, credit: conv.base, description: `Payable — ${bill.number}` },
    ],
  });
  await q(`UPDATE vendor_bill SET journal_entry_id=$2 WHERE id=$1`, [input.billId, je.entryId]);
}

// Vendor bill payment: DR Accounts payable (2000), CR cash (1000). Reduces the
// payable when a bill is settled. Deduped per bill payment id.
export async function postVendorBillPayment(input: {
  orgId: string; paymentId: string; billId: string; amount: number; currency?: string | null;
  date: string; reference?: string | null; postedBy?: string | null; postedByName?: string | null;
}): Promise<string | null> {
  if (!(await ledgerEnabled(input.orgId))) return null;
  if (!(input.amount > 0)) return null;
  if (await alreadyPosted("vendor_payment", input.paymentId)) return null;
  const ap = await acctCode(input.orgId, "2000");
  const cash = await acctCode(input.orgId, "1000");
  if (!ap || !cash) return null;
  const bill = await one<{ projectId: string | null }>(`SELECT project_id AS "projectId" FROM vendor_bill WHERE id=$1 AND org_id=$2`, [input.billId, input.orgId]);
  const conv = await convertToBase(input.orgId, input.amount, input.currency ?? "", input.date.slice(0, 10));
  const je = await postJournal({
    orgId: input.orgId, entryDate: input.date.slice(0, 10), memo: "Vendor bill payment", reference: input.reference ?? null,
    sourceType: "vendor_payment", sourceId: input.paymentId, projectId: bill?.projectId ?? null,
    postedBy: input.postedBy, postedByName: input.postedByName,
    lines: [
      { accountId: ap, debit: conv.base, description: "Settle payable" },
      { accountId: cash, credit: conv.base, description: "Cash/bank" },
    ],
  });
  return je.entryId;
}

// ---------------------------------------------------------------------------
// Multi-currency: convert a foreign amount into the org's base/reporting
// currency using the latest exchange rate on or before the given date.
// Returns the amount unchanged when currency == base or no rate is found.
// ---------------------------------------------------------------------------
export async function orgBaseCurrency(orgId: string): Promise<string> {
  const o = await one<{ base: string }>(`SELECT base_currency AS base FROM organization WHERE id=$1`, [orgId]);
  return o?.base ?? "USD";
}

export async function convertToBase(orgId: string, amount: number, currency: string, asOf: string): Promise<{ base: number; rate: number; baseCurrency: string }> {
  const baseCurrency = await orgBaseCurrency(orgId);
  if (!currency || currency === baseCurrency) return { base: round2(amount), rate: 1, baseCurrency };
  const r = await one<{ rate: number }>(
    `SELECT rate FROM exchange_rate WHERE org_id=$1 AND currency=$2 AND base_currency=$3 AND as_of <= $4::date
     ORDER BY as_of DESC LIMIT 1`, [orgId, currency, baseCurrency, asOf]
  );
  const rate = Number(r?.rate ?? 1) || 1;
  return { base: round2(Number(amount) * rate), rate, baseCurrency };
}

// Cash Flow Statement (direct method, simplified): movements on cash/bank
// accounts, split into operating inflows/outflows, with opening/closing cash.
export type CashFlow = {
  baseCurrency: string;
  opening: number; closing: number;
  inflows: { date: string; memo: string | null; amount: number }[];
  outflows: { date: string; memo: string | null; amount: number }[];
  totalIn: number; totalOut: number; netChange: number;
};

export async function cashFlowStatement(orgId: string, opts?: { from?: string; to?: string; projectId?: string }): Promise<CashFlow> {
  const baseCurrency = await orgBaseCurrency(orgId);
  // cash & bank accounts = asset accounts coded 10xx by convention, but be robust:
  const cashAccts = await q<{ id: string }>(
    `SELECT id FROM ledger_account WHERE org_id=$1 AND account_type='asset' AND (code LIKE '10%' OR name ILIKE '%cash%' OR name ILIKE '%bank%')`, [orgId]
  );
  if (cashAccts.length === 0) return { baseCurrency, opening: 0, closing: 0, inflows: [], outflows: [], totalIn: 0, totalOut: 0, netChange: 0 };
  const ids = cashAccts.map((a) => a.id);

  const from = opts?.from ?? "1900-01-01";
  const to = opts?.to ?? new Date().toISOString().slice(0, 10);
  const pid = opts?.projectId ?? null;

  // opening = net cash movement strictly before `from`
  const open = await one<{ s: number }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit),0)::float s
     FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
     WHERE jl.account_id = ANY($1::text[]) AND je.entry_date < $2::date AND ($3::text IS NULL OR jl.project_id = $3)`, [ids, from, pid]
  );
  // movements in the window, grouped by entry (so each row is one transaction).
  // Correction churn is hidden: an entry and its reversal cancel exactly, so when
  // BOTH fall inside the window neither is listed (net change is unaffected; pairs
  // straddling the window boundary are kept so opening + in − out stays exact).
  const moves = await q<{ date: string; memo: string | null; net: number }>(
    `SELECT to_char(je.entry_date, 'YYYY-MM-DD') AS date, je.memo,
            SUM(jl.debit - jl.credit)::float AS net
     FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
     WHERE jl.account_id = ANY($1::text[]) AND je.entry_date BETWEEN $2::date AND $3::date AND ($4::text IS NULL OR jl.project_id = $4)
       AND NOT EXISTS (SELECT 1 FROM journal_entry r WHERE r.reverses_entry_id = je.id AND r.entry_date <= $3::date)
       AND NOT (je.reverses_entry_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM journal_entry o WHERE o.id = je.reverses_entry_id AND o.entry_date >= $2::date))
     GROUP BY je.id, je.entry_date, je.memo
     HAVING SUM(jl.debit - jl.credit) <> 0
     ORDER BY je.entry_date`, [ids, from, to, pid]
  );
  const inflows = moves.filter((m) => m.net > 0).map((m) => ({ date: m.date, memo: m.memo, amount: round2(m.net) }));
  const outflows = moves.filter((m) => m.net < 0).map((m) => ({ date: m.date, memo: m.memo, amount: round2(-m.net) }));
  const totalIn = round2(inflows.reduce((s, m) => s + m.amount, 0));
  const totalOut = round2(outflows.reduce((s, m) => s + m.amount, 0));
  const opening = round2(open?.s ?? 0);
  return { baseCurrency, opening, closing: round2(opening + totalIn - totalOut), inflows, outflows, totalIn, totalOut, netChange: round2(totalIn - totalOut) };
}
