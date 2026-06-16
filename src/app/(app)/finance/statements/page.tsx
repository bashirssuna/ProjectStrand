import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { one } from "@/server/db";
import { institutionalStatements, cashFlowStatement } from "@/server/services/ledger";
import { PageHeader, SectionTitle, Badge } from "@/components/ui";
import { money } from "@/lib/format";

// Each statement is its own report (selected via ?report=); each can be viewed
// in Summary (condensed totals) or Details (full line items) via ?view=.
const REPORTS: [string, string, string][] = [
  ["income", "Income & Expenditure", "Statement of Income & Expenditure"],
  ["balance", "Balance Sheet", "Statement of Financial Position (Balance Sheet)"],
  ["cashflow", "Cash Flow", "Cash Flow Statement"],
  ["trial", "Trial Balance", "Trial Balance"],
];

export default async function StatementsPage({ searchParams }: { searchParams: Promise<{ report?: string; view?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const report = REPORTS.some(([k]) => k === sp.report) ? sp.report! : "income";
  const view: "summary" | "details" = sp.view === "details" ? "details" : "summary";
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";
  const fs = await institutionalStatements(orgId);
  const cf = report === "cashflow" ? await cashFlowStatement(orgId) : null;
  const fullTitle = REPORTS.find(([k]) => k === report)![2];

  const Row = ({ code, name, amount, bold }: { code?: string; name: string; amount: number; bold?: boolean }) => (
    <tr style={bold ? { fontWeight: 600 } : undefined}>
      <td className="td">{code && <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{code} </span>}{name}</td>
      <td className="td text-right tabular-nums">{money(amount, c)}</td>
    </tr>
  );
  const tabActive: React.CSSProperties = { background: "var(--brand)", color: "#fff", borderColor: "var(--brand)" };
  const segActive: React.CSSProperties = { background: "var(--fg)", color: "var(--bg)", borderColor: "var(--fg)" };

  return (
    <div className="max-w-4xl">
      <PageHeader title="Financial statements" subtitle={`Institution-wide · as at ${fs.asOf}`}
        actions={<div className="flex gap-2">
          <a href="/api/finance/statements/csv" className="btn btn-sm">⬇ CSV</a>
          <a href={`/print/finance-statements?report=${report}&view=${view}`} target="_blank" rel="noopener" className="btn btn-sm">🖨 Print / PDF</a>
          <Link href="/finance" className="btn btn-sm">← Finance</Link>
        </div>} />

      {/* Report selector — each report is its own page */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {REPORTS.map(([k, lbl]) => (
          <Link key={k} href={`/finance/statements?report=${k}&view=${view}`} className="btn btn-sm" style={report === k ? tabActive : undefined}>{lbl}</Link>
        ))}
      </div>

      {/* Summary / Details toggle + trial-balance health */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex gap-1.5">
          <Link href={`/finance/statements?report=${report}&view=summary`} className="btn btn-sm" style={view === "summary" ? segActive : undefined}>Summary</Link>
          <Link href={`/finance/statements?report=${report}&view=details`} className="btn btn-sm" style={view === "details" ? segActive : undefined}>Details</Link>
        </div>
        {fs.trialBalance.balanced
          ? <Badge tone="ok">Trial balance is balanced</Badge>
          : <Badge tone="danger">Trial balance is OUT by {money(Math.abs(fs.trialBalance.totalDebit - fs.trialBalance.totalCredit), c)}</Badge>}
      </div>

      <SectionTitle>{fullTitle}</SectionTitle>

      {/* ---- Income & Expenditure ---- */}
      {report === "income" && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {view === "details" && <>
                <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Income</td></tr>
                {fs.incomeStatement.income.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} />)}
              </>}
              <Row name="Total income" amount={fs.incomeStatement.totalIncome} bold />
              {view === "details" && <>
                <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Expenditure</td></tr>
                {fs.incomeStatement.expenses.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} />)}
              </>}
              <Row name="Total expenditure" amount={fs.incomeStatement.totalExpense} bold />
              <tr style={{ fontWeight: 700 }}>
                <td className="td">Surplus / (Deficit)</td>
                <td className="td text-right tabular-nums" style={{ color: fs.incomeStatement.surplus < 0 ? "var(--danger)" : "var(--ok)" }}>{money(fs.incomeStatement.surplus, c)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Balance Sheet ---- */}
      {report === "balance" && (<>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {view === "details" && <>
                <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Assets</td></tr>
                {fs.balanceSheet.assets.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} />)}
              </>}
              <Row name="Total assets" amount={fs.balanceSheet.totalAssets} bold />
              {view === "details" && <>
                <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Liabilities</td></tr>
                {fs.balanceSheet.liabilities.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} />)}
              </>}
              <Row name="Total liabilities" amount={fs.balanceSheet.totalLiabilities} bold />
              {view === "details" && <>
                <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Fund balances</td></tr>
                {fs.balanceSheet.equity.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} />)}
                <Row name="Current-period surplus / (deficit)" amount={fs.balanceSheet.surplus} />
              </>}
              <Row name="Total funds" amount={fs.balanceSheet.totalEquity + fs.balanceSheet.surplus} bold />
              <tr style={{ fontWeight: 700 }}>
                <td className="td">Liabilities + Funds</td>
                <td className="td text-right tabular-nums">{money(fs.balanceSheet.totalLiabilities + fs.balanceSheet.totalEquity + fs.balanceSheet.surplus, c)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs mt-2" style={{ color: fs.balanceSheet.balanced ? "var(--muted)" : "var(--danger)" }}>
          {fs.balanceSheet.balanced ? "Assets equal Liabilities plus Funds — the balance sheet balances." : "Note: assets do not yet equal liabilities plus funds — check for unbalanced opening entries."}
        </p>
      </>)}

      {/* ---- Cash Flow ---- */}
      {report === "cashflow" && cf && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              <Row name="Opening cash & bank balance" amount={cf.opening} bold />
              {view === "details" && <>
                <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Cash inflows</td></tr>
                {cf.inflows.length === 0 ? <tr><td className="td" colSpan={2} style={{ color: "var(--muted)" }}>None in period</td></tr>
                  : cf.inflows.map((m, i) => <tr key={i}><td className="td">{m.date} · {m.memo ?? "Receipt"}</td><td className="td text-right tabular-nums">{money(m.amount, c)}</td></tr>)}
              </>}
              <Row name="Total inflows" amount={cf.totalIn} bold />
              {view === "details" && <>
                <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Cash outflows</td></tr>
                {cf.outflows.length === 0 ? <tr><td className="td" colSpan={2} style={{ color: "var(--muted)" }}>None in period</td></tr>
                  : cf.outflows.map((m, i) => <tr key={i}><td className="td">{m.date} · {m.memo ?? "Payment"}</td><td className="td text-right tabular-nums">({money(m.amount, c)})</td></tr>)}
              </>}
              <Row name="Total outflows" amount={cf.totalOut} bold />
              <tr style={{ fontWeight: 700 }}>
                <td className="td">Net change in cash</td>
                <td className="td text-right tabular-nums" style={{ color: cf.netChange < 0 ? "var(--danger)" : "var(--ok)" }}>{money(cf.netChange, c)}</td>
              </tr>
              <Row name="Closing cash & bank balance" amount={cf.closing} bold />
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Trial Balance ---- */}
      {report === "trial" && (
        <div className="card overflow-x-auto">
          {view === "summary" ? (
            <table className="w-full text-sm">
              <tbody>
                <tr><td className="td">Accounts with balances</td><td className="td text-right tabular-nums">{fs.trialBalance.accounts.length}</td></tr>
                <tr style={{ fontWeight: 700 }}><td className="td">Total debits</td><td className="td text-right tabular-nums">{money(fs.trialBalance.totalDebit, c)}</td></tr>
                <tr style={{ fontWeight: 700 }}><td className="td">Total credits</td><td className="td text-right tabular-nums">{money(fs.trialBalance.totalCredit, c)}</td></tr>
              </tbody>
            </table>
          ) : (
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Account</th><th className="th text-right">Debit</th><th className="th text-right">Credit</th></tr></thead>
              <tbody>
                {fs.trialBalance.accounts.map((a) => (
                  <tr key={a.id}>
                    <td className="td"><span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{a.code}</span> {a.name}</td>
                    <td className="td text-right tabular-nums">{a.debit ? money(a.debit, c) : ""}</td>
                    <td className="td text-right tabular-nums">{a.credit ? money(a.credit, c) : ""}</td>
                  </tr>
                ))}
                <tr style={{ fontWeight: 700 }}>
                  <td className="td">Totals</td>
                  <td className="td text-right tabular-nums">{money(fs.trialBalance.totalDebit, c)}</td>
                  <td className="td text-right tabular-nums">{money(fs.trialBalance.totalCredit, c)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
