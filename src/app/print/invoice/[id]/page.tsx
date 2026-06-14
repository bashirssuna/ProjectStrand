import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { q, one } from "@/server/db";
import { money, fmtDate } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

export default async function PrintInvoice({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const inv = await one<{
    orgId: string; number: string; invoiceDate: string; dueDate: string | null; currency: string;
    total: number; amountPaid: number; status: string; description: string | null;
    customer: string | null; custEmail: string | null; custAddress: string | null; orgName: string;
  }>(
    `SELECT i.org_id AS "orgId", i.number, i.invoice_date AS "invoiceDate", i.due_date AS "dueDate", i.currency,
            i.total::float, i.amount_paid::float AS "amountPaid", i.status, i.description,
            c.name AS customer, c.email AS "custEmail", c.address AS "custAddress", o.name AS "orgName"
     FROM invoice i JOIN organization o ON o.id=i.org_id LEFT JOIN finance_customer c ON c.id=i.customer_id
     WHERE i.id=$1`, [id]
  );
  if (!inv || inv.orgId !== org.id) redirect("/dashboard");
  const lines = await q<{ description: string; quantity: number; unitPrice: number; amount: number }>(
    `SELECT description, quantity::float, unit_price::float AS "unitPrice", amount::float FROM invoice_line WHERE invoice_id=$1`, [id]
  );
  const td: React.CSSProperties = { border: "1px solid #999", padding: "7px 10px" };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap" };

  const lh = await getLetterhead(inv.orgId);
  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <PrintLetterhead lh={lh} />
        <div style={{ textAlign: "center", fontSize: 16, fontWeight: 600, letterSpacing: 1, margin: "12px 0" }}>INVOICE</div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontSize: 13 }}>
          <div>
            <div style={{ color: "#666" }}>Bill to:</div>
            <div style={{ fontWeight: 600 }}>{inv.customer ?? "—"}</div>
            {inv.custAddress && <div style={{ color: "#444" }}>{inv.custAddress}</div>}
            {inv.custEmail && <div style={{ color: "#444" }}>{inv.custEmail}</div>}
          </div>
          <div style={{ textAlign: "right" }}>
            <div>No: <strong>{inv.number}</strong></div>
            <div>Date: {fmtDate(inv.invoiceDate)}</div>
            {inv.dueDate && <div>Due: {fmtDate(inv.dueDate)}</div>}
            <div>Status: {inv.status}</div>
          </div>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 18 }}>
          <thead><tr><th style={{ ...td, background: "#f5f5f5", textAlign: "left" }}>Description</th><th style={{ ...td, background: "#f5f5f5", textAlign: "right" }}>Qty</th><th style={{ ...td, background: "#f5f5f5", textAlign: "right" }}>Unit price</th><th style={{ ...td, background: "#f5f5f5", textAlign: "right" }}>Amount</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}><td style={td}>{l.description}</td><td style={tdR}>{l.quantity}</td><td style={tdR}>{money(l.unitPrice, inv.currency)}</td><td style={tdR}>{money(l.amount, inv.currency)}</td></tr>
            ))}
            <tr style={{ fontWeight: 700 }}><td style={td} colSpan={3}>Total</td><td style={tdR}>{money(inv.total, inv.currency)}</td></tr>
            {inv.amountPaid > 0 && <tr><td style={td} colSpan={3}>Paid</td><td style={tdR}>{money(inv.amountPaid, inv.currency)}</td></tr>}
            {inv.amountPaid > 0 && <tr style={{ fontWeight: 700 }}><td style={td} colSpan={3}>Balance due</td><td style={tdR}>{money(inv.total - inv.amountPaid, inv.currency)}</td></tr>}
          </tbody>
        </table>
        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>System reference: {inv.number} · generated from Project Strand.</div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
