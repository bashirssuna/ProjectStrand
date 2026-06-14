import { redirect } from "next/navigation";
import { can } from "@/server/policy";
import { getFinancialStatements } from "@/server/services/financials";
import { money, fmtDate } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";
import { one } from "@/server/db";

// Letterhead, print-to-PDF version of all financial statements.
export default async function PrintFinancialsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await can(id, "project.view"))) redirect("/dashboard");
  const fs = await getFinancialStatements(id);
  const c = fs.currency;
  const orgRow = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [id]);
  const lh = await getLetterhead(orgRow?.orgId ?? "");
  const th: React.CSSProperties = { border: "1px solid #999", padding: "6px 9px", background: "#f5f5f5", textAlign: "left", fontSize: 12 };
  const td: React.CSSProperties = { border: "1px solid #999", padding: "6px 9px" };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap" };

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <PrintLetterhead lh={lh} subtitle={`${fs.projectCode} — ${fs.projectTitle} · Financial Statements as at ${fmtDate(fs.asOf)} · all amounts in ${c}`} />

        {/* 1. Variance */}
        <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>1. Budget vs Expenditure (Variance)</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Code</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Budget</th><th style={{ ...th, textAlign: "right" }}>Actual</th><th style={{ ...th, textAlign: "right" }}>Variance</th><th style={{ ...th, textAlign: "right" }}>% used</th></tr></thead>
          <tbody>
            {fs.variance.lines.map((l) => (
              <tr key={l.code}>
                <td style={td}>{l.code}</td><td style={td}>{l.description}</td>
                <td style={tdR}>{money(l.planned, c)}</td><td style={tdR}>{money(l.actual, c)}</td>
                <td style={{ ...tdR, color: l.variance < 0 ? "#b00" : "#070" }}>{money(l.variance, c)}</td>
                <td style={tdR}>{l.pctUsed.toFixed(0)}%</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 700 }}>
              <td style={td} colSpan={2}>TOTAL</td>
              <td style={tdR}>{money(fs.variance.totals.planned, c)}</td>
              <td style={tdR}>{money(fs.variance.totals.actual, c)}</td>
              <td style={tdR}>{money(fs.variance.totals.variance, c)}</td>
              <td style={tdR}>{fs.variance.totals.pctUsed.toFixed(0)}%</td>
            </tr>
          </tbody>
        </table>

        {/* 2. Revenue vs Expenditure */}
        <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>2. Revenue vs Expenditure (Cash &amp; Accrual)</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Basis</th><th style={{ ...th, textAlign: "right" }}>Revenue</th><th style={{ ...th, textAlign: "right" }}>Expenditure</th><th style={{ ...th, textAlign: "right" }}>Surplus / (Deficit)</th></tr></thead>
          <tbody>
            <tr><td style={td}>Cash basis</td><td style={tdR}>{money(fs.revVsExp.cash.revenue, c)}</td><td style={tdR}>{money(fs.revVsExp.cash.expenditure, c)}</td><td style={tdR}>{money(fs.revVsExp.cash.surplus, c)}</td></tr>
            <tr><td style={td}>Accrual basis</td><td style={tdR}>{money(fs.revVsExp.accrual.revenue, c)}</td><td style={tdR}>{money(fs.revVsExp.accrual.expenditure, c)}</td><td style={tdR}>{money(fs.revVsExp.accrual.surplus, c)}</td></tr>
          </tbody>
        </table>

        {/* 3. Balance Sheet */}
        <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>3. Balance Sheet (Statement of Financial Position)</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr><td style={{ ...td, fontWeight: 600 }}>Cash and bank</td><td style={tdR}>{money(fs.balanceSheet.cashAndBank, c)}</td></tr>
            <tr><td style={{ ...td, fontWeight: 600 }}>Grant receivable</td><td style={tdR}>{money(fs.balanceSheet.receivables, c)}</td></tr>
            <tr style={{ fontWeight: 700 }}><td style={td}>Total assets</td><td style={tdR}>{money(fs.balanceSheet.totalAssets, c)}</td></tr>
            <tr><td style={{ ...td, fontWeight: 600 }}>Payables (commitments)</td><td style={tdR}>{money(fs.balanceSheet.payables, c)}</td></tr>
            <tr style={{ fontWeight: 700 }}><td style={td}>Total liabilities</td><td style={tdR}>{money(fs.balanceSheet.totalLiabilities, c)}</td></tr>
            <tr style={{ fontWeight: 700 }}><td style={td}>Fund balance</td><td style={tdR}>{money(fs.balanceSheet.fundBalance, c)}</td></tr>
          </tbody>
        </table>

        {/* 4. Cashflow */}
        <h2 style={{ fontSize: 15, marginTop: 24, marginBottom: 6 }}>4. Cashflow Statement</h2>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>Month</th><th style={{ ...th, textAlign: "right" }}>Receipts</th><th style={{ ...th, textAlign: "right" }}>Payments</th><th style={{ ...th, textAlign: "right" }}>Net</th></tr></thead>
          <tbody>
            {fs.cashflow.months.length === 0 ? <tr><td style={td} colSpan={4}>No cash movements recorded yet.</td></tr> :
              fs.cashflow.months.map((m) => (
                <tr key={m.month}><td style={td}>{m.month}</td><td style={tdR}>{money(m.receipts, c)}</td><td style={tdR}>{money(m.payments, c)}</td><td style={tdR}>{money(m.net, c)}</td></tr>
              ))}
            <tr style={{ fontWeight: 700 }}><td style={td}>TOTAL</td><td style={tdR}>{money(fs.cashflow.totalReceipts, c)}</td><td style={tdR}>{money(fs.cashflow.totalPayments, c)}</td><td style={tdR}>{money(fs.cashflow.netCashflow, c)}</td></tr>
          </tbody>
        </table>

        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>
          Generated from Project Strand on {fmtDate(fs.asOf)}. Fund-accounting basis — figures derive from the project budget, recorded expenditures, commitments and disbursement vouchers.
        </div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
