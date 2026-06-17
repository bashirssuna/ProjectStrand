import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { institutionalStatements, cashFlowStatement } from "@/server/services/ledger";
import { money } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

const VALID = ["income", "balance", "cashflow", "trial"];

export default async function PrintFinanceStatements({ searchParams }: { searchParams: Promise<{ report?: string; view?: string; from?: string; to?: string; project?: string }> }) {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const sp = await searchParams;
  // No (or unknown) report -> print the full pack. Otherwise just that report.
  const only = VALID.includes(sp.report ?? "") ? sp.report! : null;
  const summary = sp.view === "summary";
  const show = (r: string) => only === null || only === r;
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const from = isDate(sp.from) ? sp.from : undefined;
  const to = isDate(sp.to) ? sp.to : undefined;
  const projectId = sp.project || undefined;
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [org.id]))?.currency ?? "USD";
  const projName = projectId ? (await one<{ code: string; title: string }>(`SELECT code, title FROM project WHERE id=$1 AND org_id=$2`, [projectId, org.id])) : null;
  const fs = await institutionalStatements(org.id, { from, to, projectId });
  const cf = show("cashflow") ? await cashFlowStatement(org.id, { from, to, projectId }) : null;
  const lh = await getLetterhead(org.id);

  const th: React.CSSProperties = { border: "1px solid #999", padding: "6px 9px", background: "#f5f5f5", textAlign: "left", fontSize: 12 };
  const td: React.CSSProperties = { border: "1px solid #999", padding: "6px 9px" };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap" };
  const sec: React.CSSProperties = { ...td, fontWeight: 700, background: "#eee" };
  const subtitleBits = [only ? VALID.find((v) => v === only)!.replace(/^\w/, (m) => m.toUpperCase()) : "Financial Statements", projName ? `${projName.code} — ${projName.title}` : "Institution-wide", from ? `${from} to ${fs.asOf}` : `as at ${fs.asOf}`, summary ? "summary" : "detailed", `amounts in ${c}`];

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <PrintLetterhead lh={lh} subtitle={subtitleBits.join(" · ")} />

        {show("income") && <>
          <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>Statement of Income &amp; Expenditure</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {!summary && <><tr><td style={sec} colSpan={2}>Income</td></tr>
                {fs.incomeStatement.income.filter((a) => a.balance !== 0).map((a) => <tr key={a.id}><td style={td}>{a.code} {a.name}</td><td style={tdR}>{money(a.balance, c)}</td></tr>)}</>}
              <tr style={{ fontWeight: 700 }}><td style={td}>Total income</td><td style={tdR}>{money(fs.incomeStatement.totalIncome, c)}</td></tr>
              {!summary && <><tr><td style={sec} colSpan={2}>Expenditure</td></tr>
                {fs.incomeStatement.expenses.filter((a) => a.balance !== 0).map((a) => <tr key={a.id}><td style={td}>{a.code} {a.name}</td><td style={tdR}>{money(a.balance, c)}</td></tr>)}</>}
              <tr style={{ fontWeight: 700 }}><td style={td}>Total expenditure</td><td style={tdR}>{money(fs.incomeStatement.totalExpense, c)}</td></tr>
              <tr style={{ fontWeight: 700 }}><td style={td}>Surplus / (Deficit)</td><td style={tdR}>{money(fs.incomeStatement.surplus, c)}</td></tr>
            </tbody>
          </table>
        </>}

        {show("balance") && <>
          <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>Statement of Financial Position</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              {!summary && <><tr><td style={sec} colSpan={2}>Assets</td></tr>
                {fs.balanceSheet.assets.filter((a) => a.balance !== 0).map((a) => <tr key={a.id}><td style={td}>{a.code} {a.name}</td><td style={tdR}>{money(a.balance, c)}</td></tr>)}</>}
              <tr style={{ fontWeight: 700 }}><td style={td}>Total assets</td><td style={tdR}>{money(fs.balanceSheet.totalAssets, c)}</td></tr>
              {!summary && <><tr><td style={sec} colSpan={2}>Liabilities</td></tr>
                {fs.balanceSheet.liabilities.filter((a) => a.balance !== 0).map((a) => <tr key={a.id}><td style={td}>{a.code} {a.name}</td><td style={tdR}>{money(a.balance, c)}</td></tr>)}</>}
              <tr style={{ fontWeight: 700 }}><td style={td}>Total liabilities</td><td style={tdR}>{money(fs.balanceSheet.totalLiabilities, c)}</td></tr>
              {!summary && <><tr><td style={sec} colSpan={2}>Fund balances</td></tr>
                {fs.balanceSheet.equity.filter((a) => a.balance !== 0).map((a) => <tr key={a.id}><td style={td}>{a.code} {a.name}</td><td style={tdR}>{money(a.balance, c)}</td></tr>)}
                <tr><td style={td}>Current-period surplus / (deficit)</td><td style={tdR}>{money(fs.balanceSheet.surplus, c)}</td></tr></>}
              <tr style={{ fontWeight: 700 }}><td style={td}>Liabilities + Funds</td><td style={tdR}>{money(fs.balanceSheet.totalLiabilities + fs.balanceSheet.totalEquity + fs.balanceSheet.surplus, c)}</td></tr>
            </tbody>
          </table>
        </>}

        {show("cashflow") && cf && <>
          <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>Cash Flow Statement</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <tbody>
              <tr style={{ fontWeight: 700 }}><td style={td}>Opening cash &amp; bank</td><td style={tdR}>{money(cf.opening, c)}</td></tr>
              {!summary && <><tr><td style={sec} colSpan={2}>Cash inflows</td></tr>
                {cf.inflows.map((m, i) => <tr key={i}><td style={td}>{m.date} · {m.memo ?? "Receipt"}</td><td style={tdR}>{money(m.amount, c)}</td></tr>)}</>}
              <tr style={{ fontWeight: 700 }}><td style={td}>Total inflows</td><td style={tdR}>{money(cf.totalIn, c)}</td></tr>
              {!summary && <><tr><td style={sec} colSpan={2}>Cash outflows</td></tr>
                {cf.outflows.map((m, i) => <tr key={i}><td style={td}>{m.date} · {m.memo ?? "Payment"}</td><td style={tdR}>({money(m.amount, c)})</td></tr>)}</>}
              <tr style={{ fontWeight: 700 }}><td style={td}>Total outflows</td><td style={tdR}>{money(cf.totalOut, c)}</td></tr>
              <tr style={{ fontWeight: 700 }}><td style={td}>Net change in cash</td><td style={tdR}>{money(cf.netChange, c)}</td></tr>
              <tr style={{ fontWeight: 700 }}><td style={td}>Closing cash &amp; bank</td><td style={tdR}>{money(cf.closing, c)}</td></tr>
            </tbody>
          </table>
        </>}

        {show("trial") && <>
          <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>Trial Balance</h2>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            {!summary && <thead><tr><th style={th}>Code</th><th style={th}>Account</th><th style={{ ...th, textAlign: "right" }}>Debit</th><th style={{ ...th, textAlign: "right" }}>Credit</th></tr></thead>}
            <tbody>
              {!summary && fs.trialBalance.accounts.map((a) => (
                <tr key={a.id}><td style={td}>{a.code}</td><td style={td}>{a.name}</td><td style={tdR}>{a.debit ? money(a.debit, c) : ""}</td><td style={tdR}>{a.credit ? money(a.credit, c) : ""}</td></tr>
              ))}
              <tr style={{ fontWeight: 700 }}><td style={td} colSpan={summary ? 1 : 2}>Totals</td><td style={tdR}>{money(fs.trialBalance.totalDebit, c)}</td><td style={tdR}>{money(fs.trialBalance.totalCredit, c)}</td></tr>
            </tbody>
          </table>
        </>}

        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>
          Generated from Project Strand on {fs.asOf}. Double-entry general ledger · {fs.trialBalance.balanced ? "trial balance balanced" : "TRIAL BALANCE OUT — review entries"}.
        </div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
