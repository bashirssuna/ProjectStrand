import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { getPlatformSettings } from "@/server/services/billing";
import { one } from "@/server/db";
import { money, fmtDate } from "@/lib/format";
import { PrintButton } from "@/components/print-button";

const termLabel = (m: number) => (m % 12 === 0 ? `${m / 12} year${m === 12 ? "" : "s"}` : `${m} months`);

export default async function PrintSubscriptionInvoice({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const req = await one<{
    orgId: string; invoiceNo: string | null; termMonths: number; subtotal: number | null; vatRate: number | null;
    vatAmount: number | null; total: number | null; currency: string | null; bankDetails: string | null;
    momoDetails: string | null; invoicedAt: string | null; invoiceNote: string | null;
    orgName: string; orgAddress: string | null; orgTin: string | null;
  }>(
    `SELECT sr.org_id AS "orgId", sr.invoice_no AS "invoiceNo", sr.term_months AS "termMonths",
            sr.invoice_subtotal::float AS subtotal, sr.vat_rate::float AS "vatRate", sr.vat_amount::float AS "vatAmount",
            sr.invoice_total::float AS total, sr.currency, sr.bank_details AS "bankDetails", sr.momo_details AS "momoDetails",
            sr.invoiced_at AS "invoicedAt", sr.invoice_note AS "invoiceNote",
            o.name AS "orgName", o.address AS "orgAddress", o.tin AS "orgTin"
     FROM subscription_request sr JOIN organization o ON o.id=sr.org_id WHERE sr.id=$1`, [id]
  );
  if (!req || !req.invoiceNo) redirect("/dashboard");
  // access: the super admin, or an admin of the organisation being billed
  if (!user.isSuperAdmin) {
    const org = await getUserOrg(user.id);
    if (!org || org.id !== req.orgId) redirect("/dashboard");
  }
  const s = await getPlatformSettings();
  const cur = req.currency ?? s.currency ?? "USD";

  const td: React.CSSProperties = { border: "1px solid #999", padding: "7px 10px" };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap" };
  const th: React.CSSProperties = { ...td, background: "#f5f5f5", textAlign: "left", fontWeight: 700 };

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 32px", fontSize: 13.5 }}>
        {/* Issuer letterhead (platform / super-admin billing identity) */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, borderBottom: "2px solid #9a6a2f", paddingBottom: 12 }}>
          <div>
            {s.issuerLogoDataUrl && <img src={s.issuerLogoDataUrl} alt="" style={{ maxHeight: 54, maxWidth: 180, objectFit: "contain", marginBottom: 6 }} />}
            <div style={{ fontWeight: 700, fontSize: 16, color: "#9a6a2f" }}>{s.issuerName || "Project Strand"}</div>
            <div style={{ color: "#555", whiteSpace: "pre-line", lineHeight: 1.5 }}>{s.issuerAddress || ""}</div>
            <div style={{ color: "#555" }}>{[s.issuerEmail, s.issuerPhone].filter(Boolean).join(" · ")}</div>
            {s.issuerWebsite && <div style={{ color: "#555" }}>{s.issuerWebsite}</div>}
            {s.issuerTin && <div style={{ color: "#555" }}>TIN: {s.issuerTin}</div>}
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 1 }}>INVOICE</div>
            <div style={{ marginTop: 4 }}>No: <strong>{req.invoiceNo}</strong></div>
            <div style={{ color: "#555" }}>Date: {req.invoicedAt ? fmtDate(req.invoicedAt) : ""}</div>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: "#888" }}>Bill to</div>
          <div style={{ fontWeight: 700 }}>{req.orgName}</div>
          {req.orgAddress && <div style={{ color: "#555", whiteSpace: "pre-line" }}>{req.orgAddress}</div>}
          {req.orgTin && <div style={{ color: "#555" }}>TIN: {req.orgTin}</div>}
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 16 }}>
          <thead><tr><th style={{ ...th, width: 40, textAlign: "center" }}>SN</th><th style={th}>Description</th><th style={{ ...th, textAlign: "right" }}>Amount ({cur})</th></tr></thead>
          <tbody>
            <tr>
              <td style={{ ...td, textAlign: "center" }}>1</td>
              <td style={td}>Project Strand subscription — {termLabel(req.termMonths)}</td>
              <td style={tdR}>{money(req.subtotal ?? 0, cur)}</td>
            </tr>
            <tr><td style={td} colSpan={2}>VAT ({req.vatRate ?? 0}%)</td><td style={tdR}>{money(req.vatAmount ?? 0, cur)}</td></tr>
            <tr style={{ fontWeight: 700 }}><td style={td} colSpan={2}>TOTAL DUE</td><td style={tdR}>{money(req.total ?? 0, cur)}</td></tr>
          </tbody>
        </table>

        <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, fontSize: 12.5 }}>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 3 }}>Bank transfer</div>
            <div style={{ color: "#333", whiteSpace: "pre-line", lineHeight: 1.5 }}>{req.bankDetails || "—"}</div>
          </div>
          <div>
            <div style={{ fontWeight: 700, marginBottom: 3 }}>Mobile money</div>
            <div style={{ color: "#333", whiteSpace: "pre-line", lineHeight: 1.5 }}>{req.momoDetails || "—"}</div>
          </div>
        </div>
        {req.invoiceNote && <p style={{ marginTop: 12, color: "#444" }}>{req.invoiceNote}</p>}

        {/* Authorised / signature block — this is the "signed" issuance */}
        <div style={{ marginTop: 40, display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ fontSize: 12, color: "#555" }}>
            Once paid, upload your proof of payment in Project Strand and we will activate your subscription.
          </div>
          <div style={{ width: 260, textAlign: "center" }}>
            {s.issuerLogoDataUrl && <img src={s.issuerLogoDataUrl} alt="" style={{ maxHeight: 40, maxWidth: 120, objectFit: "contain", opacity: 0.85 }} />}
            <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12, marginTop: 4 }}>
              <div style={{ fontWeight: 600 }}>Authorised — {s.issuerName || "Project Strand"}</div>
              <div style={{ color: "#555" }}>Digitally issued &amp; system-signed</div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 24, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>System reference: {req.invoiceNo} · generated automatically from Project Strand.</div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
