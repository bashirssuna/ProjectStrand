import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { institutionalStatements } from "@/server/services/ledger";
import { money } from "@/lib/format";
import { PrintButton } from "@/components/print-button";

export default async function PrintFinanceStatements() {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [org.id]))?.currency ?? "USD";
  const fs = await institutionalStatements(org.id);

  const th: React.CSSProperties = { border: "1px solid #999", padding: "6px 9px", background: "#f5f5f5", textAlign: "left", fontSize: 12 };
  const td: React.CSSProperties = { border: "1px solid #999", padding: "6px 9px" };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap" };
  const sec: React.CSSProperties = { ...td, fontWeight: 700, background: "#eee" };

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <div style={{ textAlign: "center", borderBottom: "3px double #111", paddingBottom: 14 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{fs.orgName}</div>
          <div style={{ fontSize: 12, marginTop: 4, color: "#444" }}>Financial Statements · as at {fs.asOf} · all amounts in {c}</div>
        </div>

        <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>Statement of Income &amp; Expenditure</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr><td style={sec} colSpan={2}>Income</td></tr>
            {fs.incomeStatement.income.filter((a) => a.balance !== 0).map((a) => <tr key={a.id}><td style={td}>{a.code} {a.name}</td><td style={tdR}>{money(a.balance, c)}</td></tr>)}
            <tr style={{ fontWeight: 700 }}><td style={td}>Total income</td><td style={tdR}>{money(fs.incomeStatement.totalIncome, c)}</td></tr>
            <tr><td style={sec} colSpan={2}>Expenditure</td></tr>
            {fs.incomeStatement.expenses.filter((a) => a.balance !== 0).map((a) => <tr key={a.id}><td style={td}>{a.code} {a.name}</td><td style={tdR}>{money(a.balance, c)}</td></tr>)}
            <tr style={{ fontWeight: 700 }}><td style={td}>Total expenditure</td><td style={tdR}>{money(fs.incomeStatement.totalExpense, c)}</td></tr>
            <tr style={{ fontWeight: 700 }}><td style={td}>Surplus / (Deficit)</td><td style={tdR}>{money(fs.incomeStatement.surplus, c)}</td></tr>
          </tbody>
        </table>

        <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>Statement of Financial Position</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr><td style={sec} colSpan={2}>Assets</td></tr>
            {fs.balanceSheet.assets.filter((a) => a.balance !== 0).map((a) => <tr key={a.id}><td style={td}>{a.code} {a.name}</td><td style={tdR}>{money(a.balance, c)}</td></tr>)}
            <tr style={{ fontWeight: 700 }}><td style={td}>Total assets</td><td style={tdR}>{money(fs.balanceSheet.totalAssets, c)}</td></tr>
            <tr><td style={sec} colSpan={2}>Liabilities</td></tr>
            {fs.balanceSheet.liabilities.filter((a) => a.balance !== 0).map((a) => <tr key={a.id}><td style={td}>{a.code} {a.name}</td><td style={tdR}>{money(a.balance, c)}</td></tr>)}
            <tr style={{ fontWeight: 700 }}><td style={td}>Total liabilities</td><td style={tdR}>{money(fs.balanceSheet.totalLiabilities, c)}</td></tr>
            <tr><td style={sec} colSpan={2}>Fund balances</td></tr>
            {fs.balanceSheet.equity.filter((a) => a.balance !== 0).map((a) => <tr key={a.id}><td style={td}>{a.code} {a.name}</td><td style={tdR}>{money(a.balance, c)}</td></tr>)}
            <tr><td style={td}>Current-period surplus / (deficit)</td><td style={tdR}>{money(fs.balanceSheet.surplus, c)}</td></tr>
            <tr style={{ fontWeight: 700 }}><td style={td}>Liabilities + Funds</td><td style={tdR}>{money(fs.balanceSheet.totalLiabilities + fs.balanceSheet.totalEquity + fs.balanceSheet.surplus, c)}</td></tr>
          </tbody>
        </table>

        <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>Trial Balance</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Code</th><th style={th}>Account</th><th style={{ ...th, textAlign: "right" }}>Debit</th><th style={{ ...th, textAlign: "right" }}>Credit</th></tr></thead>
          <tbody>
            {fs.trialBalance.accounts.map((a) => (
              <tr key={a.id}><td style={td}>{a.code}</td><td style={td}>{a.name}</td><td style={tdR}>{a.debit ? money(a.debit, c) : ""}</td><td style={tdR}>{a.credit ? money(a.credit, c) : ""}</td></tr>
            ))}
            <tr style={{ fontWeight: 700 }}><td style={td} colSpan={2}>Totals</td><td style={tdR}>{money(fs.trialBalance.totalDebit, c)}</td><td style={tdR}>{money(fs.trialBalance.totalCredit, c)}</td></tr>
          </tbody>
        </table>

        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>
          Generated from Project Strand on {fs.asOf}. Double-entry general ledger · {fs.trialBalance.balanced ? "trial balance balanced" : "TRIAL BALANCE OUT — review entries"}.
        </div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
