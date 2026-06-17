import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { institutionalStatements, cashFlowStatement, accountTransactions } from "@/server/services/ledger";
import { PageHeader, SectionTitle, Badge } from "@/components/ui";
import { money } from "@/lib/format";
import { label } from "@/lib/enums";

// Each statement is its own report (selected via ?report=); Summary (totals) or
// Details (line items) via ?view=. Optionally scoped to ?from/?to/?project, and
// any account in Details can be drilled into its transactions via ?account=.
const REPORTS: [string, string, string][] = [
  ["income", "Income & Expenditure", "Statement of Income & Expenditure"],
  ["balance", "Balance Sheet", "Statement of Financial Position (Balance Sheet)"],
  ["cashflow", "Cash Flow", "Cash Flow Statement"],
  ["trial", "Trial Balance", "Trial Balance"],
];
const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export default async function StatementsPage({ searchParams }: { searchParams: Promise<{ report?: string; view?: string; from?: string; to?: string; project?: string; account?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const report = REPORTS.some(([k]) => k === sp.report) ? sp.report! : "income";
  const view: "summary" | "details" = sp.view === "details" ? "details" : "summary";
  const from = isDate(sp.from) ? sp.from : undefined;
  const to = isDate(sp.to) ? sp.to : undefined;

  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]);
  const projectId = sp.project && projects.some((p) => p.id === sp.project) ? sp.project : undefined;
  const account = sp.account || undefined;
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";

  const fs = await institutionalStatements(orgId, { from, to, projectId });
  const cf = report === "cashflow" ? await cashFlowStatement(orgId, { from, to, projectId }) : null;
  const txns = account ? await accountTransactions(orgId, account, { from, to, projectId }) : null;
  const fullTitle = REPORTS.find(([k]) => k === report)![2];

  const paramStr = (over: Record<string, string | undefined> = {}) => {
    const base: Record<string, string | undefined> = { report, view, from, to, project: projectId, account, ...over };
    const m: Record<string, string> = {};
    for (const [k, v] of Object.entries(base)) if (v) m[k] = v;
    return new URLSearchParams(m).toString();
  };
  const href = (over: Record<string, string | undefined> = {}) => `/finance/statements?${paramStr(over)}`;
  const csvHref = `/api/finance/statements/csv?${paramStr({ account: undefined })}`;
  const printHref = `/print/finance-statements?${paramStr({ account: undefined })}`;

  const proj = projectId ? projects.find((p) => p.id === projectId) : null;
  const scope = proj ? `${proj.code} — ${proj.title}` : "Institution-wide";
  const periodLabel = report === "balance" || report === "trial" ? `as at ${fs.asOf}` : from ? `${from} → ${fs.asOf}` : `up to ${fs.asOf}`;

  const Row = ({ code, name, amount, bold, accountId }: { code?: string; name: string; amount: number; bold?: boolean; accountId?: string }) => (
    <tr style={bold ? { fontWeight: 600 } : undefined}>
      <td className="td">
        {code && <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{code} </span>}
        {accountId ? <Link href={href({ account: accountId })} className="hover:underline" style={{ color: "var(--brand)" }}>{name}</Link> : name}
      </td>
      <td className="td text-right tabular-nums">{money(amount, c)}</td>
    </tr>
  );
  const tabActive: React.CSSProperties = { background: "var(--brand)", color: "#fff", borderColor: "var(--brand)" };
  const segActive: React.CSSProperties = { background: "var(--fg)", color: "var(--bg)", borderColor: "var(--fg)" };

  return (
    <div className="max-w-4xl">
      <PageHeader title="Financial statements" subtitle={`${scope} · ${periodLabel}`}
        actions={<div className="flex gap-2">
          <a href={csvHref} className="btn btn-sm">⬇ CSV</a>
          <a href={printHref} target="_blank" rel="noopener" className="btn btn-sm">🖨 Print / PDF</a>
          <Link href="/finance" className="btn btn-sm">← Finance</Link>
        </div>} />

      {/* Report selector */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {REPORTS.map(([k, lbl]) => (
          <Link key={k} href={href({ report: k, account: undefined })} className="btn btn-sm" style={report === k ? tabActive : undefined}>{lbl}</Link>
        ))}
      </div>

      {/* Date range + project scope */}
      <form method="get" action="/finance/statements" className="card p-3 mb-4 flex flex-wrap items-end gap-3">
        <input type="hidden" name="report" value={report} />
        <input type="hidden" name="view" value={view} />
        {account && <input type="hidden" name="account" value={account} />}
        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--muted)" }}>From</label>
          <input type="date" name="from" defaultValue={from ?? ""} className="input" />
        </div>
        <div>
          <label className="block text-xs mb-1" style={{ color: "var(--muted)" }}>To</label>
          <input type="date" name="to" defaultValue={to ?? ""} className="input" />
        </div>
        <div className="min-w-[16rem]">
          <label className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Project</label>
          <select name="project" defaultValue={projectId ?? ""} className="select w-full">
            <option value="">All projects (institution-wide)</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}
          </select>
        </div>
        <button className="btn btn-primary" type="submit">Apply</button>
        {(from || to || projectId) && <a href={`/finance/statements?report=${report}&view=${view}`} className="btn btn-sm">Clear</a>}
      </form>

      {report === "balance" && from && (
        <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>The balance sheet is a cumulative snapshot as at the To date; the From date doesn’t apply to it.</p>
      )}

      {/* ===== Account drill-down ===== */}
      {txns && txns.account ? (<>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <SectionTitle>{txns.account.code} · {txns.account.name} — transactions</SectionTitle>
          <Link href={href({ account: undefined })} className="btn btn-sm">← Back to {fullTitle}</Link>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Date</th>
              <th className="th text-left">Entry</th>
              <th className="th text-left">Narration</th>
              <th className="th text-left">Project</th>
              <th className="th text-right">Debit</th>
              <th className="th text-right">Credit</th>
              <th className="th text-right">Balance</th>
            </tr></thead>
            <tbody>
              {from && <tr style={{ color: "var(--muted)" }}><td className="td" colSpan={6}>Opening balance (before {from})</td><td className="td text-right tabular-nums">{money(txns.opening, c)}</td></tr>}
              {txns.lines.length === 0 ? (
                <tr><td className="td" colSpan={7} style={{ color: "var(--muted)" }}>No transactions in this account for the selected filters.</td></tr>
              ) : txns.lines.map((l) => (
                <tr key={l.id}>
                  <td className="td whitespace-nowrap">{l.date}</td>
                  <td className="td font-mono text-xs">{l.entryNo}</td>
                  <td className="td">{l.description || l.memo || label(l.sourceType)}</td>
                  <td className="td text-xs">{l.projectCode ?? "—"}</td>
                  <td className="td text-right tabular-nums">{l.debit ? money(l.debit, c) : ""}</td>
                  <td className="td text-right tabular-nums">{l.credit ? money(l.credit, c) : ""}</td>
                  <td className="td text-right tabular-nums">{money(l.running, c)}</td>
                </tr>
              ))}
              <tr style={{ fontWeight: 700 }}>
                <td className="td" colSpan={4}>Totals</td>
                <td className="td text-right tabular-nums">{money(txns.totalDebit, c)}</td>
                <td className="td text-right tabular-nums">{money(txns.totalCredit, c)}</td>
                <td className="td text-right tabular-nums">{money(txns.closing, c)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Running balance is kept on the account’s normal side ({txns.account.normalSide}).</p>
      </>) : (<>
        {/* Summary / Details toggle + trial-balance health */}
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex gap-1.5">
            <Link href={href({ view: "summary" })} className="btn btn-sm" style={view === "summary" ? segActive : undefined}>Summary</Link>
            <Link href={href({ view: "details" })} className="btn btn-sm" style={view === "details" ? segActive : undefined}>Details</Link>
          </div>
          {fs.trialBalance.balanced
            ? <Badge tone="ok">Trial balance is balanced</Badge>
            : <Badge tone="danger">Trial balance is OUT by {money(Math.abs(fs.trialBalance.totalDebit - fs.trialBalance.totalCredit), c)}</Badge>}
        </div>

        <SectionTitle>{fullTitle}</SectionTitle>
        {view === "details" && <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Tip: click any account to see the transactions behind it.</p>}

        {/* ---- Income & Expenditure ---- */}
        {report === "income" && (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {view === "details" && <>
                  <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Income</td></tr>
                  {fs.incomeStatement.income.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} accountId={a.id} />)}
                </>}
                <Row name="Total income" amount={fs.incomeStatement.totalIncome} bold />
                {view === "details" && <>
                  <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Expenditure</td></tr>
                  {fs.incomeStatement.expenses.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} accountId={a.id} />)}
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
                  {fs.balanceSheet.assets.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} accountId={a.id} />)}
                </>}
                <Row name="Total assets" amount={fs.balanceSheet.totalAssets} bold />
                {view === "details" && <>
                  <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Liabilities</td></tr>
                  {fs.balanceSheet.liabilities.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} accountId={a.id} />)}
                </>}
                <Row name="Total liabilities" amount={fs.balanceSheet.totalLiabilities} bold />
                {view === "details" && <>
                  <tr><td className="td font-medium" colSpan={2} style={{ background: "var(--surface)" }}>Fund balances</td></tr>
                  {fs.balanceSheet.equity.filter((a) => a.balance !== 0).map((a) => <Row key={a.id} code={a.code} name={a.name} amount={a.balance} accountId={a.id} />)}
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
                      <td className="td"><span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{a.code}</span> <Link href={href({ account: a.id })} className="hover:underline" style={{ color: "var(--brand)" }}>{a.name}</Link></td>
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
      </>)}
    </div>
  );
}
