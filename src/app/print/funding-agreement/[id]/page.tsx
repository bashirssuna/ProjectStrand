import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { getAgreement, listTranches, listReceipts } from "@/server/services/funding";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

export default async function PrintFundingAgreement({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const a = await getAgreement(org.id, id);
  if (!a) redirect("/dashboard");
  const [tranches, receipts, lh] = await Promise.all([listTranches(org.id, id), listReceipts(org.id, id), getLetterhead(org.id)]);
  const ccy = a.currency;

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: 32 }}>
        <div className="no-print" style={{ marginBottom: 12, textAlign: "right" }}><PrintButton /></div>
        <PrintLetterhead lh={lh} subtitle="Grant / Funding Agreement Statement" />

        <h2 style={{ fontSize: 16, fontWeight: 700, margin: "8px 0" }}>{a.title}</h2>
        <table style={{ width: "100%", fontSize: 13, marginBottom: 16 }}>
          <tbody>
            <tr><td style={{ padding: "2px 8px", color: "#555" }}>Donor</td><td style={{ padding: "2px 8px", fontWeight: 600 }}>{a.donor}</td>
                <td style={{ padding: "2px 8px", color: "#555" }}>Reference</td><td style={{ padding: "2px 8px" }}>{a.reference ?? "—"}</td></tr>
            <tr><td style={{ padding: "2px 8px", color: "#555" }}>Project</td><td style={{ padding: "2px 8px" }}>{a.projectTitle ?? "—"}</td>
                <td style={{ padding: "2px 8px", color: "#555" }}>Status</td><td style={{ padding: "2px 8px" }}>{label(a.status)}</td></tr>
            <tr><td style={{ padding: "2px 8px", color: "#555" }}>Term</td><td style={{ padding: "2px 8px" }}>{a.startDate ? fmtDate(a.startDate) : "—"} – {a.endDate ? fmtDate(a.endDate) : "—"}</td>
                <td style={{ padding: "2px 8px", color: "#555" }}>Focal person</td><td style={{ padding: "2px 8px" }}>{a.focalPerson ?? "—"}</td></tr>
          </tbody>
        </table>

        <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
          <Box label="Committed" value={money(a.totalAmount, ccy)} />
          <Box label="Received" value={money(a.received, ccy)} />
          <Box label="Outstanding" value={money(a.outstanding, ccy)} />
        </div>

        <h3 style={{ fontSize: 13, fontWeight: 700, margin: "16px 0 6px" }}>Disbursement schedule</h3>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: "2px solid #333" }}>
            <th style={{ textAlign: "left", padding: 6 }}>Tranche</th><th style={{ textAlign: "left", padding: 6 }}>Expected</th>
            <th style={{ textAlign: "right", padding: 6 }}>Amount</th><th style={{ textAlign: "right", padding: 6 }}>Received</th>
            <th style={{ textAlign: "right", padding: 6 }}>Outstanding</th><th style={{ textAlign: "left", padding: 6 }}>Status</th>
          </tr></thead>
          <tbody>
            {tranches.map((t) => (
              <tr key={t.id} style={{ borderBottom: "1px solid #ddd" }}>
                <td style={{ padding: 6 }}>{t.label}</td>
                <td style={{ padding: 6 }}>{t.expectedDate ? fmtDate(t.expectedDate) : "—"}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{money(t.amount, ccy)}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{money(t.received, ccy)}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{money(t.outstanding, ccy)}</td>
                <td style={{ padding: 6 }}>{label(t.status)}</td>
              </tr>
            ))}
            {tranches.length === 0 && <tr><td colSpan={6} style={{ padding: 12, textAlign: "center", color: "#777" }}>No tranches.</td></tr>}
          </tbody>
        </table>

        <h3 style={{ fontSize: 13, fontWeight: 700, margin: "16px 0 6px" }}>Receipts</h3>
        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: "2px solid #333" }}>
            <th style={{ textAlign: "left", padding: 6 }}>Date</th><th style={{ textAlign: "left", padding: 6 }}>Tranche</th>
            <th style={{ textAlign: "left", padding: 6 }}>Method / Ref</th><th style={{ textAlign: "right", padding: 6 }}>Amount</th>
          </tr></thead>
          <tbody>
            {receipts.map((r) => (
              <tr key={r.id} style={{ borderBottom: "1px solid #ddd" }}>
                <td style={{ padding: 6 }}>{fmtDate(r.receiptDate)}</td>
                <td style={{ padding: 6 }}>{r.trancheLabel ?? "—"}</td>
                <td style={{ padding: 6 }}>{[r.method, r.reference].filter(Boolean).join(" · ") || "—"}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{money(r.amount, ccy)}</td>
              </tr>
            ))}
            {receipts.length === 0 && <tr><td colSpan={4} style={{ padding: 12, textAlign: "center", color: "#777" }}>No receipts recorded.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Box({ label, value }: { label: string; value: string }) {
  return <div style={{ flex: 1, border: "1px solid #ccc", borderRadius: 6, padding: "8px 12px" }}><div style={{ fontSize: 11, color: "#666" }}>{label}</div><div style={{ fontSize: 15, fontWeight: 700 }}>{value}</div></div>;
}
