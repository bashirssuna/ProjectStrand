import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";

// ===========================================================================
// General Ledger service. The one rule that makes double-entry trustworthy:
// every journal entry's lines must sum to zero (total debits == total credits).
// postJournal() enforces this and is the ONLY supported way to write to the
// ledger. Entries are immutable; reverseJournal() posts an offsetting entry.
// ===========================================================================

export type JournalLineInput = {
  accountId: string;
  debit?: number;
  credit?: number;
  description?: string;
  projectId?: string | null;
};

const round2 = (n: number | string) => { const x = Number(n) || 0; return Math.round((x + Number.EPSILON) * 100) / 100; };

// Posts a balanced journal entry. Throws if it doesn't balance or has no lines.
export async function postJournal(input: {
  orgId: string;
  entryDate: string;            // YYYY-MM-DD
  memo?: string;
  sourceType?: "manual" | "expenditure" | "voucher" | "reversal";
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
    `INSERT INTO journal_entry (id, org_id, entry_no, entry_date, memo, source_type, source_id, project_id, reverses_entry_id, posted_by, posted_by_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [entryId, input.orgId, entryNo, input.entryDate, input.memo ?? null,
     input.sourceType ?? "manual", input.sourceId ?? null, input.projectId ?? null,
     input.reversesEntryId ?? null, input.postedBy ?? null, input.postedByName ?? null]
  );
  for (const l of lines) {
    await q(
      `INSERT INTO journal_line (id, entry_id, account_id, project_id, debit, credit, description)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id("jl"), entryId, l.accountId, l.projectId ?? input.projectId ?? null,
       round2(l.debit ?? 0), round2(l.credit ?? 0), l.description ?? null]
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
export async function accountBalances(orgId: string, opts?: { upTo?: string; projectId?: string }): Promise<AccountBalance[]> {
  const params: (string | null)[] = [orgId];
  let where = `la.org_id=$1`;
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
  trialBalance: { accounts: AccountBalance[]; totalDebit: number; totalCredit: number; balanced: boolean };
  incomeStatement: { income: AccountBalance[]; expenses: AccountBalance[]; totalIncome: number; totalExpense: number; surplus: number };
  balanceSheet: { assets: AccountBalance[]; liabilities: AccountBalance[]; equity: AccountBalance[]; totalAssets: number; totalLiabilities: number; totalEquity: number; surplus: number; balanced: boolean };
};

// Institution-wide statements rolled up from the ledger across all projects.
export async function institutionalStatements(orgId: string, upTo?: string): Promise<InstitutionalStatements> {
  const org = (await one<{ name: string }>(`SELECT name FROM organization WHERE id=$1`, [orgId]))!;
  const bals = await accountBalances(orgId, { upTo });

  const totalDebit = round2(bals.reduce((s, a) => s + a.debit, 0));
  const totalCredit = round2(bals.reduce((s, a) => s + a.credit, 0));

  const income = bals.filter((a) => a.accountType === "income");
  const expenses = bals.filter((a) => a.accountType === "expense");
  const totalIncome = round2(income.reduce((s, a) => s + a.balance, 0));
  const totalExpense = round2(expenses.reduce((s, a) => s + a.balance, 0));
  const surplus = round2(totalIncome - totalExpense);

  const assets = bals.filter((a) => a.accountType === "asset");
  const liabilities = bals.filter((a) => a.accountType === "liability");
  const equity = bals.filter((a) => a.accountType === "equity");
  const totalAssets = round2(assets.reduce((s, a) => s + a.balance, 0));
  const totalLiabilities = round2(liabilities.reduce((s, a) => s + a.balance, 0));
  const totalEquity = round2(equity.reduce((s, a) => s + a.balance, 0));

  return {
    orgName: org.name,
    asOf: upTo ?? new Date().toISOString().slice(0, 10),
    trialBalance: { accounts: bals.filter((a) => a.debit !== 0 || a.credit !== 0), totalDebit, totalCredit, balanced: totalDebit === totalCredit },
    incomeStatement: { income, expenses, totalIncome, totalExpense, surplus },
    // Assets = Liabilities + Equity + net surplus (current-year result not yet closed to equity)
    balanceSheet: { assets, liabilities, equity, totalAssets, totalLiabilities, totalEquity, surplus, balanced: round2(totalAssets) === round2(totalLiabilities + totalEquity + surplus) },
  };
}

// Posts the journal for a recorded expenditure, using the org's posting rule
// (debit expense account, credit cash/bank). Maps the budget line's category to
// a sensible expense account when possible. No-op if no chart of accounts yet.
export async function postExpenditureToLedger(input: {
  orgId: string; projectId: string; expenditureId: string; amount: number; date: string;
  reference?: string | null; payee?: string | null; postedBy?: string | null; postedByName?: string | null;
}): Promise<void> {
  const haveCoa = await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ledger_account WHERE org_id=$1`, [input.orgId]);
  if (!haveCoa || haveCoa.c === 0) return; // ledger not enabled for this org
  // don't double-post the same expenditure
  const dup = await one<{ id: string }>(`SELECT id FROM journal_entry WHERE source_type='expenditure' AND source_id=$1`, [input.expenditureId]);
  if (dup) return;

  const rule = await one<{ debit: string | null; credit: string | null }>(
    `SELECT debit_account_id AS debit, credit_account_id AS credit FROM gl_posting_rule WHERE org_id=$1 AND rule_key='expenditure'`, [input.orgId]
  );
  let debitAcc = rule?.debit ?? null;
  const creditAcc = rule?.credit ?? (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='1000'`, [input.orgId]))?.id ?? null;
  if (!debitAcc) debitAcc = (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='5200'`, [input.orgId]))?.id ?? null;
  if (!debitAcc || !creditAcc) return;

  await postJournal({
    orgId: input.orgId,
    entryDate: input.date.slice(0, 10),
    memo: `Expenditure${input.reference ? ` ${input.reference}` : ""}${input.payee ? ` — ${input.payee}` : ""}`,
    sourceType: "expenditure",
    sourceId: input.expenditureId,
    projectId: input.projectId,
    postedBy: input.postedBy, postedByName: input.postedByName,
    lines: [
      { accountId: debitAcc, debit: input.amount, description: "Expenditure", projectId: input.projectId },
      { accountId: creditAcc, credit: input.amount, description: "Cash/bank", projectId: input.projectId },
    ],
  });
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

export async function cashFlowStatement(orgId: string, opts?: { from?: string; to?: string }): Promise<CashFlow> {
  const baseCurrency = await orgBaseCurrency(orgId);
  // cash & bank accounts = asset accounts coded 10xx by convention, but be robust:
  const cashAccts = await q<{ id: string }>(
    `SELECT id FROM ledger_account WHERE org_id=$1 AND account_type='asset' AND (code LIKE '10%' OR name ILIKE '%cash%' OR name ILIKE '%bank%')`, [orgId]
  );
  if (cashAccts.length === 0) return { baseCurrency, opening: 0, closing: 0, inflows: [], outflows: [], totalIn: 0, totalOut: 0, netChange: 0 };
  const ids = cashAccts.map((a) => a.id);

  const from = opts?.from ?? "1900-01-01";
  const to = opts?.to ?? new Date().toISOString().slice(0, 10);

  // opening = net cash movement strictly before `from`
  const open = await one<{ s: number }>(
    `SELECT COALESCE(SUM(jl.debit - jl.credit),0)::float s
     FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
     WHERE jl.account_id = ANY($1::text[]) AND je.entry_date < $2::date`, [ids, from]
  );
  // movements in the window, grouped by entry (so each row is one transaction)
  const moves = await q<{ date: string; memo: string | null; net: number }>(
    `SELECT je.entry_date AS date, je.memo,
            SUM(jl.debit - jl.credit)::float AS net
     FROM journal_line jl JOIN journal_entry je ON je.id=jl.entry_id
     WHERE jl.account_id = ANY($1::text[]) AND je.entry_date BETWEEN $2::date AND $3::date
     GROUP BY je.id, je.entry_date, je.memo
     HAVING SUM(jl.debit - jl.credit) <> 0
     ORDER BY je.entry_date`, [ids, from, to]
  );
  const inflows = moves.filter((m) => m.net > 0).map((m) => ({ date: m.date, memo: m.memo, amount: round2(m.net) }));
  const outflows = moves.filter((m) => m.net < 0).map((m) => ({ date: m.date, memo: m.memo, amount: round2(-m.net) }));
  const totalIn = round2(inflows.reduce((s, m) => s + m.amount, 0));
  const totalOut = round2(outflows.reduce((s, m) => s + m.amount, 0));
  const opening = round2(open?.s ?? 0);
  return { baseCurrency, opening, closing: round2(opening + totalIn - totalOut), inflows, outflows, totalIn, totalOut, netChange: round2(totalIn - totalOut) };
}
