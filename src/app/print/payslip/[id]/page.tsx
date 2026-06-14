import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { q, one } from "@/server/db";
import { money } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

export default async function PrintPayslip({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const s = await one<{
    orgId: string; basic: number; gross: number; deductions: number; net: number; currency: string;
    empFirst: string; empLast: string; staffNo: string | null; jobTitle: string | null; bankName: string | null;
    bankAccount: string | null; period: string; orgName: string;
  }>(
    `SELECT ps.basic::float, ps.gross::float, ps.deductions::float, ps.net::float, ps.currency,
            e.first_name AS "empFirst", e.last_name AS "empLast", e.staff_no AS "staffNo", e.job_title AS "jobTitle",
            e.bank_name AS "bankName", e.bank_account AS "bankAccount", pr.period_label AS period,
            o.name AS "orgName", o.id AS "orgId"
     FROM payslip ps JOIN employee e ON e.id=ps.employee_id JOIN payroll_run pr ON pr.id=ps.run_id JOIN organization o ON o.id=pr.org_id
     WHERE ps.id=$1`, [id]
  );
  if (!s || s.orgId !== org.id) redirect("/dashboard");
  const lines = await q<{ name: string; kind: string; amount: number }>(`SELECT name, kind, amount::float FROM payslip_line WHERE payslip_id=$1`, [id]);
  const earnings = lines.filter((l) => l.kind === "earning");
  const deductions = lines.filter((l) => l.kind === "deduction");
  const td: React.CSSProperties = { border: "1px solid #999", padding: "6px 10px" };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap" };

  const lh = await getLetterhead(s.orgId);
  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <PrintLetterhead lh={lh} subtitle={`PAYSLIP — ${s.period}`} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontSize: 13 }}>
          <div><div style={{ fontWeight: 600 }}>{s.empFirst} {s.empLast}</div><div style={{ color: "#444" }}>{s.jobTitle ?? ""}</div>{s.staffNo && <div style={{ color: "#444" }}>Staff no: {s.staffNo}</div>}</div>
          <div style={{ textAlign: "right", color: "#444" }}>{s.bankName && <div>{s.bankName}</div>}{s.bankAccount && <div>A/C: {s.bankAccount}</div>}</div>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 18 }}>
          <thead><tr><th style={{ ...td, background: "#f5f5f5", textAlign: "left" }}>Earnings</th><th style={{ ...td, background: "#f5f5f5", textAlign: "right" }}>Amount</th></tr></thead>
          <tbody>
            <tr><td style={td}>Basic salary</td><td style={tdR}>{money(s.basic, s.currency)}</td></tr>
            {earnings.map((l, i) => <tr key={i}><td style={td}>{l.name}</td><td style={tdR}>{money(l.amount, s.currency)}</td></tr>)}
            <tr style={{ fontWeight: 700 }}><td style={td}>Gross pay</td><td style={tdR}>{money(s.gross, s.currency)}</td></tr>
          </tbody>
        </table>

        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
          <thead><tr><th style={{ ...td, background: "#f5f5f5", textAlign: "left" }}>Deductions</th><th style={{ ...td, background: "#f5f5f5", textAlign: "right" }}>Amount</th></tr></thead>
          <tbody>
            {deductions.length === 0 ? <tr><td style={td} colSpan={2}>None</td></tr> : deductions.map((l, i) => <tr key={i}><td style={td}>{l.name}</td><td style={tdR}>{money(l.amount, s.currency)}</td></tr>)}
            <tr style={{ fontWeight: 700 }}><td style={td}>Total deductions</td><td style={tdR}>{money(s.deductions, s.currency)}</td></tr>
          </tbody>
        </table>

        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
          <tbody><tr style={{ fontWeight: 700, fontSize: 16 }}><td style={{ ...td, background: "#eee" }}>NET PAY</td><td style={{ ...tdR, background: "#eee" }}>{money(s.net, s.currency)}</td></tr></tbody>
        </table>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 40 }}>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12, color: "#555" }}>Prepared by</div>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12, color: "#555" }}>Employee signature</div>
        </div>
        <div style={{ marginTop: 24, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>Generated from Project Strand · {s.period}.</div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
