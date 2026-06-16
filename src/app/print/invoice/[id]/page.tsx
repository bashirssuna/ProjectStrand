import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { q, one } from "@/server/db";
import { money, fmtDate } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";
import { convertToBase } from "@/server/services/ledger";

export default async function PrintInvoice({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const inv = await one<{
    orgId: string; number: string; invoiceDate: string; dueDate: string | null; currency: string;
    total: number; amountPaid: number; status: string; description: string | null;
    awardNumber: string | null; awardee: string | null; signatoryName: string | null; signatoryTitle: string | null;
    customer: string | null; custEmail: string | null; custAddress: string | null; custPhone: string | null;
    custFax: string | null; contactName: string | null; contactTitle: string | null;
  }>(
    `SELECT i.org_id AS "orgId", i.number, i.invoice_date AS "invoiceDate", i.due_date AS "dueDate", i.currency,
            i.total::float, i.amount_paid::float AS "amountPaid", i.status, i.description,
            i.award_number AS "awardNumber", i.awardee, i.signatory_name AS "signatoryName", i.signatory_title AS "signatoryTitle",
            c.name AS customer, c.email AS "custEmail", c.address AS "custAddress", c.phone AS "custPhone",
            c.fax AS "custFax", c.contact_name AS "contactName", c.contact_title AS "contactTitle"
     FROM invoice i LEFT JOIN finance_customer c ON c.id=i.customer_id
     WHERE i.id=$1`, [id]
  );
  if (!inv || inv.orgId !== org.id) redirect("/dashboard");
  const lines = await q<{ description: string; quantity: number; unitPrice: number; amount: number }>(
    `SELECT description, quantity::float, unit_price::float AS "unitPrice", amount::float FROM invoice_line WHERE invoice_id=$1 ORDER BY id`, [id]
  );
  const lh = await getLetterhead(inv.orgId);
  const fx = await convertToBase(inv.orgId, inv.total, inv.currency, inv.invoiceDate);
  const showFx = fx.baseCurrency !== inv.currency && fx.rate !== 1;

  const td: React.CSSProperties = { border: "1px solid #999", padding: "7px 10px" };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap" };
  const th: React.CSSProperties = { ...td, background: "#f5f5f5", textAlign: "left", fontWeight: 700 };
  const lineLabel: React.CSSProperties = { color: "#555", width: 90, display: "inline-block", verticalAlign: "top" };

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 32px", fontSize: 13.5 }}>
        <PrintLetterhead lh={lh} />

        <div style={{ textAlign: "right", marginTop: 14, color: "#333" }}>Date: {fmtDate(inv.invoiceDate)}</div>

        {/* Attention / recipient block */}
        <div style={{ marginTop: 6, lineHeight: 1.55 }}>
          {inv.contactName && <div><span style={lineLabel}>Attention:</span><strong>{inv.contactName}</strong>{inv.contactTitle ? `, ${inv.contactTitle}` : ""}</div>}
          {inv.customer && <div><span style={lineLabel}>{inv.contactName ? "" : "To:"}</span>{inv.customer}</div>}
          {inv.custAddress && <div><span style={lineLabel} />{inv.custAddress}</div>}
          {(inv.custPhone || inv.custFax) && <div><span style={lineLabel} />{inv.custPhone ? `Tel: ${inv.custPhone}` : ""}{inv.custPhone && inv.custFax ? "  ·  " : ""}{inv.custFax ? `Fax: ${inv.custFax}` : ""}</div>}
          {inv.custEmail && <div><span style={lineLabel} />Email: {inv.custEmail}</div>}
        </div>

        {/* Award details */}
        {(inv.awardNumber || inv.awardee) && (
          <div style={{ marginTop: 12, lineHeight: 1.55 }}>
            {inv.awardNumber && <div><span style={lineLabel}>Award no:</span><strong>{inv.awardNumber}</strong></div>}
            {inv.awardee && <div><span style={lineLabel}>Awardee:</span>{inv.awardee}</div>}
          </div>
        )}

        <div style={{ textAlign: "center", fontSize: 17, fontWeight: 700, letterSpacing: 1, margin: "20px 0 4px" }}>INVOICE</div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#333", marginBottom: 8 }}>
          <span>Invoice No: <strong style={{ color: "#111" }}>{inv.number}</strong></span>
          {inv.dueDate && <span>Due: {fmtDate(inv.dueDate)}</span>}
        </div>
        {inv.description && <div style={{ marginBottom: 8, color: "#444" }}>{inv.description}</div>}

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={{ ...th, width: 40, textAlign: "center" }}>SN</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Amount ({inv.currency})</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td style={{ ...td, textAlign: "center" }}>{i + 1}</td>
                <td style={td}>{l.description}{l.quantity && l.quantity !== 1 ? ` (${l.quantity} × ${money(l.unitPrice, inv.currency)})` : ""}</td>
                <td style={tdR}>{money(l.amount, inv.currency)}</td>
              </tr>
            ))}
            <tr style={{ fontWeight: 700 }}><td style={td} colSpan={2}>TOTAL DUE</td><td style={tdR}>{money(inv.total, inv.currency)}</td></tr>
            {inv.amountPaid > 0 && <tr><td style={td} colSpan={2}>Paid to date</td><td style={tdR}>{money(inv.amountPaid, inv.currency)}</td></tr>}
            {inv.amountPaid > 0 && <tr style={{ fontWeight: 700 }}><td style={td} colSpan={2}>Balance due</td><td style={tdR}>{money(inv.total - inv.amountPaid, inv.currency)}</td></tr>}
          </tbody>
        </table>

        {showFx && (
          <div style={{ marginTop: 10, fontSize: 12, color: "#444" }}>
            Exchange rate: 1 {inv.currency} = {fx.rate} {fx.baseCurrency} · Equivalent {money(fx.base, fx.baseCurrency)} in reporting currency.
          </div>
        )}

        {lh.bankDetails && (
          <div style={{ marginTop: 20, fontSize: 12.5 }}>
            <div style={{ fontWeight: 700, marginBottom: 3 }}>Payment details</div>
            <div style={{ color: "#333", whiteSpace: "pre-line", lineHeight: 1.5 }}>{lh.bankDetails}</div>
          </div>
        )}

        {/* Signatory */}
        <div style={{ marginTop: 46, width: 280 }}>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12 }}>
            {inv.signatoryName && <div style={{ fontWeight: 600 }}>{inv.signatoryName}</div>}
            {inv.signatoryTitle && <div style={{ color: "#555" }}>{inv.signatoryTitle}</div>}
            <div style={{ color: "#555", marginTop: 4 }}>Signature, date &amp; official stamp</div>
          </div>
        </div>

        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>System reference: {inv.number} · generated from Project Strand.</div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
