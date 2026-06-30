import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { postJournal, orgBaseCurrency } from "./ledger";
import { latestRates } from "./currency";

const round2 = (n: number | string) => { const x = Number(n) || 0; return Math.round((x + Number.EPSILON) * 100) / 100; };

// Single P&L account for net foreign-exchange gains/losses. Created on first use
// (a chart of accounts must already exist).
export async function getFxAccount(orgId: string): Promise<string | null> {
  const rule = await one<{ a: string }>(`SELECT debit_account_id AS a FROM gl_posting_rule WHERE org_id=$1 AND rule_key='fx_revaluation'`, [orgId]);
  if (rule?.a) return rule.a;
  const existing = await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='7900'`, [orgId]);
  if (existing?.id) return existing.id;
  const haveCoa = await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ledger_account WHERE org_id=$1`, [orgId]);
  if (!haveCoa || haveCoa.c === 0) return null;
  await q(`INSERT INTO ledger_account (id, org_id, code, name, account_type, normal_side)
           VALUES ($1,$2,'7900','Foreign exchange gain/(loss)','income','credit') ON CONFLICT (org_id, code) DO NOTHING`, [id("acct"), orgId]);
  return (await one<{ id: string }>(`SELECT id FROM ledger_account WHERE org_id=$1 AND code='7900'`, [orgId]))?.id ?? null;
}

// Record a foreign-currency transaction: convert to base at the transaction-date
// rate and store the foreign exposure on the line(s). Throws if no rate is known
// for that date (never posts a fabricated 1:1 rate).
export async function postForeignEntry(input: {
  orgId: string; date: string; debitAccountId: string; creditAccountId: string;
  currency: string; foreignAmount: number; rate?: number | null;
  memo?: string; reference?: string | null; projectId?: string | null; postedBy?: string | null; postedByName?: string | null;
}): Promise<{ entryNo: string; base: number; rate: number }> {
  const baseCur = await orgBaseCurrency(input.orgId);
  const isForeign = input.currency !== baseCur;
  let rate = 1;
  if (isForeign) {
    if (input.rate && input.rate > 0) rate = input.rate;
    else {
      const onFile = await one<{ r: number }>(
        `SELECT rate::float8 AS r FROM exchange_rate WHERE org_id=$1 AND currency=$2 AND base_currency=$3 AND as_of <= $4::date ORDER BY as_of DESC LIMIT 1`,
        [input.orgId, input.currency, baseCur, input.date]);
      if (!onFile) throw new Error(`No exchange rate on file for ${input.currency}→${baseCur} as of ${input.date}.`);
      rate = onFile.r;
    }
  }
  const base = round2(input.foreignAmount * rate);
  const fx = { currency: isForeign ? input.currency : null, fxAmount: isForeign ? input.foreignAmount : null, fxRate: isForeign ? rate : null };
  const res = await postJournal({
    orgId: input.orgId, entryDate: input.date.slice(0, 10), memo: input.memo, reference: input.reference ?? null,
    sourceType: "manual", projectId: input.projectId ?? null, postedBy: input.postedBy, postedByName: input.postedByName,
    lines: [
      { accountId: input.debitAccountId, debit: base, description: input.memo, ...fx },
      { accountId: input.creditAccountId, credit: base, description: input.memo, ...fx },
    ],
  });
  return { entryNo: res.entryNo, base, rate };
}

export type ForeignBalance = { accountId: string; code: string; name: string; accountType: string; currency: string; foreignBal: number; currentBase: number };

// Foreign-currency monetary balances (asset/liability accounts only) as at a date.
export async function foreignBalances(orgId: string, asOf: string): Promise<ForeignBalance[]> {
  const base = await orgBaseCurrency(orgId);
  return q<ForeignBalance>(
    `SELECT la.id AS "accountId", la.code, la.name, la.account_type AS "accountType", jl.currency,
            SUM(CASE WHEN jl.debit>0 THEN COALESCE(jl.fx_amount,0) ELSE -COALESCE(jl.fx_amount,0) END)::float8 AS "foreignBal",
            SUM(jl.debit - jl.credit)::float8 AS "currentBase"
     FROM journal_line jl
     JOIN journal_entry je ON je.id=jl.entry_id
     JOIN ledger_account la ON la.id=jl.account_id
     WHERE je.org_id=$1 AND je.entry_date <= $2::date
       AND jl.currency IS NOT NULL AND jl.currency <> $3
       AND la.account_type IN ('asset','liability')
     GROUP BY la.id, la.code, la.name, la.account_type, jl.currency
     HAVING SUM(CASE WHEN jl.debit>0 THEN COALESCE(jl.fx_amount,0) ELSE -COALESCE(jl.fx_amount,0) END) <> 0
     ORDER BY la.code, jl.currency`, [orgId, asOf, base]);
}

export type RevalItem = ForeignBalance & { rate: number | null; rateAsOf: string | null; revaluedBase: number | null; fxDiff: number | null; converted: boolean };

export async function revaluationWorksheet(orgId: string, asOf: string): Promise<{
  base: string; asOf: string; items: RevalItem[]; totalGainLoss: number; unconverted: RevalItem[];
}> {
  const { base, rates } = await latestRates(orgId, asOf);
  const rows = await foreignBalances(orgId, asOf);
  const items: RevalItem[] = rows.map((r) => {
    const rate = rates[r.currency]?.rate ?? null;
    const converted = rate != null;
    const revaluedBase = converted ? round2(r.foreignBal * rate!) : null;
    const fxDiff = revaluedBase != null ? round2(revaluedBase - r.currentBase) : null;
    return { ...r, rate, rateAsOf: rates[r.currency]?.asOf ?? null, revaluedBase, fxDiff, converted };
  });
  const totalGainLoss = round2(items.reduce((s, i) => s + (i.fxDiff ?? 0), 0));
  return { base, asOf, items, totalGainLoss, unconverted: items.filter((i) => !i.converted) };
}

// Post the period-end revaluation: bring each foreign monetary account's base
// value to the closing rate; the net difference goes to FX gain/loss.
export async function postRevaluation(orgId: string, asOf: string, userId?: string | null, userName?: string | null): Promise<{ entryNo: string; net: number; accounts: number }> {
  const ws = await revaluationWorksheet(orgId, asOf);
  const conv = ws.items.filter((i) => i.converted && i.fxDiff != null && Math.abs(i.fxDiff) >= 0.01);
  if (conv.length === 0) throw new Error("Nothing to revalue — no rate differences for the foreign balances on file.");
  const fxAccount = await getFxAccount(orgId);
  if (!fxAccount) throw new Error("Initialise the chart of accounts before running a revaluation.");

  const lines: Parameters<typeof postJournal>[0]["lines"] = [];
  let net = 0;
  for (const i of conv) {
    const d = i.fxDiff!; net += d;
    lines.push({
      accountId: i.accountId, debit: d > 0 ? d : 0, credit: d < 0 ? -d : 0,
      description: `FX revaluation ${i.currency} @ ${i.rate}`,
      currency: i.currency, fxAmount: 0, fxRate: i.rate,   // base adjustment only; no change to foreign balance
    });
  }
  const fx = round2(-net);
  lines.push({ accountId: fxAccount, debit: fx > 0 ? fx : 0, credit: fx < 0 ? -fx : 0, description: net >= 0 ? "Unrealised FX gain" : "Unrealised FX loss" });

  const res = await postJournal({
    orgId, entryDate: asOf, memo: `Foreign-currency revaluation as at ${asOf}`,
    sourceType: "fx_revaluation", postedBy: userId, postedByName: userName, lines,
  });
  return { entryNo: res.entryNo, net: round2(net), accounts: conv.length };
}
