import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { getSlip, getPayees } from "@/server/services/payment-slips";
import { money, fmtDate } from "@/lib/format";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

const CCY_NAME: Record<string, string> = { UGX: "SHILLINGS", KES: "SHILLINGS", TZS: "SHILLINGS", RWF: "FRANCS", USD: "DOLLARS", EUR: "EUROS", GBP: "POUNDS", NGN: "NAIRA", ZAR: "RAND", GHS: "CEDIS" };
function amountToWords(n: number): string {
  const ones = ["", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"];
  const tens = ["", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"];
  const scales = ["", "THOUSAND", "MILLION", "BILLION", "TRILLION"];
  let v = Math.floor(Math.abs(n));
  if (v === 0) return "ZERO";
  const chunk = (num: number): string => {
    let s = "";
    if (num >= 100) { s += ones[Math.floor(num / 100)] + " HUNDRED"; num %= 100; if (num) s += " "; }
    if (num >= 20) { s += tens[Math.floor(num / 10)]; num %= 10; if (num) s += " " + ones[num]; }
    else if (num > 0) s += ones[num];
    return s;
  };
  const parts: string[] = [];
  let i = 0;
  while (v > 0) { const c = v % 1000; if (c) parts.unshift(chunk(c) + (scales[i] ? " " + scales[i] : "")); v = Math.floor(v / 1000); i++; }
  return parts.join(" ");
}

export default async function PrintPaymentSlipPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  const slip = await getSlip(id, org.id);
  if (!slip) { if (!user.isSuperAdmin) redirect("/dashboard"); else redirect("/finance/payment-slips"); }
  if (!org.isOrgAdmin && !user.isSuperAdmin) redirect("/dashboard");
  const s = slip!;
  const payees = await getPayees(id);
  const total = payees.reduce((a, p) => a + p.amount, 0);
  const c = s.currency;
  const words = `${amountToWords(total)} ${CCY_NAME[c] ?? c} ONLY`;
  const lh = await getLetterhead(org.id);
  const single = payees.length === 1 ? payees[0] : null;

  const cell: React.CSSProperties = { border: "1px solid #999", padding: "6px 8px" };
  const th: React.CSSProperties = { ...cell, background: "#f0f0f0", fontWeight: 600, fontSize: 12, textAlign: "left" };

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: single ? 760 : 1040, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <PrintLetterhead lh={lh} subtitle={s.project ? `Project: ${s.project}` : undefined} />

        <div style={{ textAlign: "center", margin: "18px 0 6px", fontSize: 17, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
          Payment {single ? "Voucher" : "Schedule"}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#444", marginBottom: 4 }}>
          <span>No: <strong style={{ color: "#111" }}>{s.number}</strong></span>
          <span>Category: {s.category ?? "—"}</span>
          <span>Date: {fmtDate(s.slipDate)}</span>
        </div>
        <div style={{ fontSize: 13, fontWeight: 600, margin: "6px 0 12px" }}>{s.title}</div>

        {single ? (
          /* ---- Individual voucher layout ---- */
          <>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {[["Payee", single.name], ["Phone", single.phone ?? "—"], ["Designation", single.designation ?? "—"], ["Payment for", single.paymentFor ?? s.category ?? "—"]].map(([k, v]) => (
                  <tr key={k}><td style={{ ...cell, width: 170, fontWeight: 600, background: "#f5f5f5" }}>{k}</td><td style={cell}>{v}</td></tr>
                ))}
                <tr><td style={{ ...cell, fontWeight: 700, background: "#f5f5f5" }}>Amount</td><td style={{ ...cell, fontWeight: 700, fontSize: 16 }}>{money(single.amount, c)}</td></tr>
              </tbody>
            </table>
            <div style={{ marginTop: 8, fontSize: 12 }}><strong>Amount in words:</strong> {words}</div>
          </>
        ) : (
          /* ---- Group schedule table ---- */
          <>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead><tr>
                <th style={{ ...th, width: 32 }}>No.</th><th style={{ ...th, width: 78 }}>Date</th><th style={th}>Name</th>
                <th style={th}>Phone</th><th style={th}>Email</th><th style={th}>Designation</th><th style={th}>Payment for</th>
                <th style={{ ...th, textAlign: "right" }}>Amount</th><th style={{ ...th, width: 150 }}>Signature</th>
              </tr></thead>
              <tbody>
                {payees.map((p) => (
                  <tr key={p.id}>
                    <td style={cell}>{p.idx}</td>
                    <td style={cell}>{fmtDate(s.slipDate)}</td>
                    <td style={cell}>{p.name}</td>
                    <td style={cell}>{p.phone ?? ""}</td>
                    <td style={cell}>{p.email ?? ""}</td>
                    <td style={cell}>{p.designation ?? ""}</td>
                    <td style={cell}>{p.paymentFor ?? s.category ?? ""}</td>
                    <td style={{ ...cell, textAlign: "right", whiteSpace: "nowrap" }}>{money(p.amount, c)}</td>
                    <td style={{ ...cell, height: 38 }}>{p.signed && p.signature ? <img src={p.signature} alt="" style={{ height: 30 }} /> : ""}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ ...cell, fontWeight: 700, background: "#f5f5f5" }} colSpan={7}>TOTAL</td>
                  <td style={{ ...cell, fontWeight: 700, textAlign: "right", whiteSpace: "nowrap" }}>{money(total, c)}</td>
                  <td style={cell} />
                </tr>
              </tbody>
            </table>
            <div style={{ marginTop: 8, fontSize: 12 }}><strong>Amount in words:</strong> {words}</div>
          </>
        )}

        {/* Approval sign-off (Finance + PI) */}
        <div style={{ display: "grid", gridTemplateColumns: single ? "1fr 1fr 1fr" : "1fr 1fr", gap: 22, marginTop: 36 }}>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12 }}>
            {s.financeSignature ? <img src={s.financeSignature} alt="" style={{ height: 38, marginBottom: 4 }} /> : <div style={{ height: 42 }} />}
            <div style={{ fontWeight: 600 }}>{s.financeSignedName || "\u00A0"}</div>
            <div style={{ color: "#555" }}>Finance (Approved &amp; signed)</div>
            <div style={{ color: "#888", fontSize: 11 }}>{s.financeSignedAt ? fmtDate(s.financeSignedAt) : ""}</div>
          </div>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12 }}>
            {s.piSignature ? <img src={s.piSignature} alt="" style={{ height: 38, marginBottom: 4 }} /> : <div style={{ height: 42 }} />}
            <div style={{ fontWeight: 600 }}>{s.piSignedName || "\u00A0"}</div>
            <div style={{ color: "#555" }}>Principal Investigator (Authorised)</div>
            <div style={{ color: "#888", fontSize: 11 }}>{s.piSignedAt ? fmtDate(s.piSignedAt) : ""}</div>
          </div>
          {single && (
            <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12 }}>
              {single.signed && single.signature ? <img src={single.signature} alt="" style={{ height: 38, marginBottom: 4 }} /> : <div style={{ height: 42 }} />}
              <div style={{ fontWeight: 600 }}>{single.signedName || single.name}</div>
              <div style={{ color: "#555" }}>Received by (payee)</div>
              <div style={{ color: "#888", fontSize: 11 }}>{single.signedAt ? fmtDate(single.signedAt) : ""}</div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>
          System reference: {s.number} · prepared by {s.preparedByName ?? "—"} · generated from Project Strand.
        </div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
