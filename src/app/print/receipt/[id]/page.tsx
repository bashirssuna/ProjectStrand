import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

export default async function PrintReceipt({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const r = await one<{
    orgId: string; number: string; receiptDate: string; amount: number; currency: string; method: string;
    reference: string | null; note: string | null; customer: string | null; invoiceNo: string | null; orgName: string;
  }>(
    `SELECT rc.org_id AS "orgId", rc.number, rc.receipt_date AS "receiptDate", rc.amount::float, rc.currency, rc.method,
            rc.reference, rc.note, c.name AS customer, i.number AS "invoiceNo", o.name AS "orgName"
     FROM receipt rc JOIN organization o ON o.id=rc.org_id
     LEFT JOIN finance_customer c ON c.id=rc.customer_id LEFT JOIN invoice i ON i.id=rc.invoice_id
     WHERE rc.id=$1`, [id]
  );
  if (!r || r.orgId !== org.id) redirect("/dashboard");
  const td: React.CSSProperties = { border: "1px solid #999", padding: "7px 10px", width: 170, fontWeight: 600, background: "#f5f5f5" };
  const tv: React.CSSProperties = { border: "1px solid #999", padding: "7px 10px" };

  const lh = await getLetterhead(r.orgId);
  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 640, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <PrintLetterhead lh={lh} />
        <div style={{ textAlign: "center", fontSize: 16, fontWeight: 600, letterSpacing: 1, margin: "12px 0" }}>OFFICIAL RECEIPT</div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#444", margin: "14px 0" }}>
          <span>No: <strong style={{ color: "#111" }}>{r.number}</strong></span>
          <span>Date: {fmtDate(r.receiptDate)}</span>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            <tr><td style={td}>Received from</td><td style={tv}>{r.customer ?? "—"}</td></tr>
            <tr><td style={td}>The sum of</td><td style={{ ...tv, fontWeight: 700, fontSize: 16 }}>{money(r.amount, r.currency)}</td></tr>
            <tr><td style={td}>Payment method</td><td style={tv}>{label(r.method)}</td></tr>
            {r.invoiceNo && <tr><td style={td}>Against invoice</td><td style={tv}>{r.invoiceNo}</td></tr>}
            <tr><td style={td}>Reference</td><td style={tv}>{r.reference ?? "—"}</td></tr>
            {r.note && <tr><td style={td}>Note</td><td style={tv}>{r.note}</td></tr>}
          </tbody>
        </table>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 40 }}>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12, color: "#555" }}>Received by</div>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12, color: "#555" }}>Date &amp; stamp</div>
        </div>
        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>System reference: {r.number} · generated from Project Strand.</div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
