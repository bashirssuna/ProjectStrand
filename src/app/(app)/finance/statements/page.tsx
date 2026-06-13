import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { one } from "@/server/db";
import { institutionalStatements, cashFlowStatement } from "@/server/services/ledger";
import { PageHeader, SectionTitle, Badge } from "@/components/ui";
import { money } from "@/lib/format";

export default async function StatementsPage() {
  const { orgId } = await requireFinanceOrg();
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";
  const fs = await institutionalStatements(orgId);
  const cf = await cashFlowStatement(orgId);

  const Row = ({ code, name, amount, bold }: { code?: string; name: string; amount: number; bold?: boolean }) => (
    <tr style={bold ? { fontWeight: 600 } : undefined}>
      <td className="td">{code && <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{code} </span>}{name}</td>
      <td className="td text-right tabular-nums">{money(amount, c)}</td>
    </tr>
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title="Financial statements" subtitle={`Institution-wide · as at ${fs.asOf}`}
        actions={<div className="flex gap-2">
          <a href="/api/finance/statements/csv" className="btn btn-sm">⬇ CSV</a>
          <a href="/print/finance-statements" target="_blank" rel="noopener" className="btn btn-sm">🖨 Print / PDF</a>
          <Link href="/finance" className="btn btn-sm">← Finance</Link>
        </div>} />

      <div className="mb-3">
        {fs.trialBalance.balanced
          ? <Badge tone="ok">Trial balance is balanced</Badge>
          : <Badge tone="danger">Trial balance is OUT by {money(Math.abs(fs.trialBalance.totalDebit - fs.trialBalance.totalCredit), c)}</Badge>}
      </div>

      {/* Income statement */}
      <SectionTitle>Statement of Income &amp; Expenditure</SectionTitle>
      <div className="card overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <tbody>
            <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Income</td></tr>
            {fs.incomeStatement.income.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} />)}
            <Row name="Total income" amount={fs.incomeStatement.totalIncome} bold />
            <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Expenditure</td></tr>
            {fs.incomeStatement.expenses.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} />)}
            <Row name="Total expenditure" amount={fs.incomeStatement.totalExpense} bold />
            <tr style={{ fontWeight: 700 }}>
              <td className="td">Surplus / (Deficit)</td>
              <td className="td text-right tabular-nums" style={{ color: fs.incomeStatement.surplus < 0 ? "var(--danger)" : "var(--ok)" }}>{money(fs.incomeStatement.surplus, c)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Balance sheet */}
      <SectionTitle>Statement of Financial Position (Balance Sheet)</SectionTitle>
      <div className="card overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <tbody>
            <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Assets</td></tr>
            {fs.balanceSheet.assets.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} />)}
            <Row name="Total assets" amount={fs.balanceSheet.totalAssets} bold />
            <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Liabilities</td></tr>
            {fs.balanceSheet.liabilities.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} />)}
            <Row name="Total liabilities" amount={fs.balanceSheet.totalLiabilities} bold />
            <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Fund balances</td></tr>
            {fs.balanceSheet.equity.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} />)}
            <Row name="Current-period surplus / (deficit)" amount={fs.balanceSheet.surplus} />
            <Row name="Total funds" amount={fs.balanceSheet.totalEquity + fs.balanceSheet.surplus} bold />
            <tr style={{ fontWeight: 700 }}>
              <td className="td">Liabilities + Funds</td>
              <td className="td text-right tabular-nums">{money(fs.balanceSheet.totalLiabilities + fs.balanceSheet.totalEquity + fs.balanceSheet.surplus, c)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs mb-6" style={{ color: fs.balanceSheet.balanced ? "var(--muted)" : "var(--danger)" }}>
        {fs.balanceSheet.balanced ? "Assets equal Liabilities plus Funds — the balance sheet balances." : "Note: assets do not yet equal liabilities plus funds — check for unbalanced opening entries."}
      </p>

      {/* Cash flow */}
      <SectionTitle>Cash Flow Statement</SectionTitle>
      <div className="card overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <tbody>
            <Row name="Opening cash & bank balance" amount={cf.opening} bold />
            <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Cash inflows</td></tr>
            {cf.inflows.length === 0 ? <tr><td className="td" colSpan={2} style={{ color: "var(--muted)" }}>None in period</td></tr>
              : cf.inflows.map((m, i) => <tr key={i}><td className="td">{m.date} · {m.memo ?? "Receipt"}</td><td className="td text-right tabular-nums">{money(m.amount, c)}</td></tr>)}
            <Row name="Total inflows" amount={cf.totalIn} bold />
            <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Cash outflows</td></tr>
            {cf.outflows.length === 0 ? <tr><td className="td" colSpan={2} style={{ color: "var(--muted)" }}>None in period</td></tr>
              : cf.outflows.map((m, i) => <tr key={i}><td className="td">{m.date} · {m.memo ?? "Payment"}</td><td className="td text-right tabular-nums">({money(m.amount, c)})</td></tr>)}
            <Row name="Total outflows" amount={cf.totalOut} bold />
            <tr style={{ fontWeight: 700 }}>
              <td className="td">Net change in cash</td>
              <td className="td text-right tabular-nums" style={{ color: cf.netChange < 0 ? "var(--danger)" : "var(--ok)" }}>{money(cf.netChange, c)}</td>
            </tr>
            <Row name="Closing cash & bank balance" amount={cf.closing} bold />
          </tbody>
        </table>
      </div>

      {/* Trial balance */}
      <SectionTitle>Trial Balance</SectionTitle>
      <div className="card overflow-x-auto">
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
      </div>
    </div>
  );
}
