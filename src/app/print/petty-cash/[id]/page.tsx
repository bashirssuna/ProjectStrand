import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { getAccount, listTxns } from "@/server/services/pettycash";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

export default async function PrintPettyCash({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const a = await getAccount(org.id, id);
  if (!a) redirect("/dashboard");
  const txns = await listTxns(org.id, id);
  const lh = await getLetterhead(org.id);
  const ccy = a.currency;
  const ordered = [...txns].reverse(); // oldest first for a statement

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: 32 }}>
        <div className="no-print" style={{ marginBottom: 12, textAlign: "right" }}><PrintButton /></div>
        <PrintLetterhead lh={lh} subtitle="Petty Cash Account Statement" />

        <table style={{ width: "100%", fontSize: 13, marginBottom: 16 }}>
          <tbody>
            <tr><td style={{ padding: "2px 8px", color: "#555" }}>Float</td><td style={{ padding: "2px 8px", fontWeight: 600 }}>{a.name}</td>
                <td style={{ padding: "2px 8px", color: "#555" }}>Currency</td><td style={{ padding: "2px 8px" }}>{ccy}</td></tr>
            <tr><td style={{ padding: "2px 8px", color: "#555" }}>Custodian</td><td style={{ padding: "2px 8px" }}>{a.custodian ?? "—"}</td>
                <td style={{ padding: "2px 8px", color: "#555" }}>Project</td><td style={{ padding: "2px 8px" }}>{a.projectTitle ?? "—"}</td></tr>
            <tr><td style={{ padding: "2px 8px", color: "#555" }}>Float limit</td><td style={{ padding: "2px 8px" }}>{money(a.floatLimit, ccy)}</td>
                <td style={{ padding: "2px 8px", color: "#555" }}>Cash on hand</td><td style={{ padding: "2px 8px", fontWeight: 600 }}>{money(a.balance, ccy)}</td></tr>
          </tbody>
        </table>

        <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #333" }}>
              <th style={{ textAlign: "left", padding: 6 }}>Date</th>
              <th style={{ textAlign: "left", padding: 6 }}>Type</th>
              <th style={{ textAlign: "left", padding: 6 }}>Details</th>
              <th style={{ textAlign: "right", padding: 6 }}>Out</th>
              <th style={{ textAlign: "right", padding: 6 }}>In</th>
              <th style={{ textAlign: "right", padding: 6 }}>Balance</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((t) => (
              <tr key={t.id} style={{ borderBottom: "1px solid #ddd" }}>
                <td style={{ padding: 6, whiteSpace: "nowrap" }}>{fmtDate(t.txnDate)}</td>
                <td style={{ padding: 6 }}>{label(t.type)}</td>
                <td style={{ padding: 6 }}>{[t.payee || t.description, t.category, t.budgetLineCode ? `Budget ${t.budgetLineCode}` : null, t.reference ? `Ref ${t.reference}` : null].filter(Boolean).join(" · ") || "—"}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{t.signed < 0 ? money(Math.abs(t.signed), ccy) : ""}</td>
                <td style={{ padding: 6, textAlign: "right" }}>{t.signed > 0 ? money(t.signed, ccy) : ""}</td>
                <td style={{ padding: 6, textAlign: "right", fontWeight: 600 }}>{money(t.balanceAfter, ccy)}</td>
              </tr>
            ))}
            {ordered.length === 0 && <tr><td colSpan={6} style={{ padding: 12, textAlign: "center", color: "#777" }}>No transactions.</td></tr>}
          </tbody>
        </table>

        <div style={{ marginTop: 40, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
          <div>Prepared by: __________________________</div>
          <div>Verified by: __________________________</div>
        </div>
      </div>
    </div>
  );
}
