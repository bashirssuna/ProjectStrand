import { redirect } from "next/navigation";
import { one, q } from "@/server/db";
import { getProjectAccess } from "@/server/policy";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";

export default async function PrintVoucherPage({ params }: { params: Promise<{ vid: string }> }) {
  const { vid } = await params;
  const v = await one<{
    projectId: string; number: string; payee: string; amount: number; method: string;
    reference: string | null; purpose: string | null; createdAt: string; preparedBy: string | null;
    reqNumber: string; reqTitle: string; org: string; projectTitle: string; projectCode: string; currency: string;
  }>(
    `SELECT pv.project_id AS "projectId", pv.number, pv.payee, pv.amount, pv.method, pv.reference,
            pv.purpose, pv.created_at AS "createdAt", pv.prepared_by_name AS "preparedBy",
            r.number AS "reqNumber", r.title AS "reqTitle",
            o.name AS org, p.title AS "projectTitle", p.code AS "projectCode", p.currency
     FROM payment_voucher pv
     JOIN requisition r ON r.id=pv.requisition_id
     JOIN project p ON p.id=pv.project_id
     JOIN organization o ON o.id=p.org_id
     WHERE pv.id=$1`, [vid]
  );
  if (!v) redirect("/dashboard");
  const access = await getProjectAccess(v.projectId);
  if (!access.permissions.has("project.view")) redirect("/dashboard");
  // signatures of approvers on the underlying requisition
  const approvals = await q<{ role: string; approver: string | null; signature: string | null }>(
    `SELECT ra.role, u.name AS approver,
            (SELECT data_url FROM signature_asset WHERE user_id=ra.approver_id ORDER BY created_at DESC LIMIT 1) AS signature
     FROM requisition_approval ra LEFT JOIN app_user u ON u.id=ra.approver_id
     JOIN payment_voucher pv ON pv.requisition_id=ra.requisition_id
     WHERE pv.id=$1 AND ra.decision='approved' ORDER BY ra.step`, [vid]
  );

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <div style={{ textAlign: "center", borderBottom: "3px double #111", paddingBottom: 14 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>{v.org}</div>
          <div style={{ fontSize: 12, marginTop: 4, color: "#444" }}>Project: {v.projectCode} — {v.projectTitle}</div>
        </div>

        <div style={{ textAlign: "center", margin: "18px 0 6px", fontSize: 17, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
          Payment Voucher
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#444", marginBottom: 14 }}>
          <span>No: <strong style={{ color: "#111" }}>{v.number}</strong></span>
          <span>Date: {fmtDate(v.createdAt)}</span>
          <span>Requisition: {v.reqNumber}</span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {[
              ["Pay to", v.payee],
              ["Purpose", v.purpose ?? v.reqTitle],
              ["Payment method", label(v.method)],
              ["Reference", v.reference ?? "—"],
              ["Prepared by", v.preparedBy ?? "—"],
            ].map(([k, val]) => (
              <tr key={k as string}>
                <td style={{ border: "1px solid #999", padding: "7px 10px", width: 170, fontWeight: 600, background: "#f5f5f5" }}>{k}</td>
                <td style={{ border: "1px solid #999", padding: "7px 10px" }}>{val}</td>
              </tr>
            ))}
            <tr>
              <td style={{ border: "1px solid #999", padding: "7px 10px", fontWeight: 700, background: "#f5f5f5" }}>Amount</td>
              <td style={{ border: "1px solid #999", padding: "7px 10px", fontWeight: 700, fontSize: 16 }}>{money(v.amount, v.currency)}</td>
            </tr>
          </tbody>
        </table>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, marginTop: 34 }}>
          {(approvals.length ? approvals.slice(0, 2) : [{ role: "approved_by", approver: "", signature: null }]).map((a, i) => (
            <div key={i} style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12 }}>
              {a.signature ? <img src={a.signature} alt="" style={{ height: 36, marginBottom: 4 }} /> : <div style={{ height: 40 }} />}
              <div style={{ fontWeight: 600 }}>{a.approver || "\u00A0"}</div>
              <div style={{ color: "#555" }}>{label(a.role)}</div>
            </div>
          ))}
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12 }}>
            <div style={{ height: 40 }} />
            <div style={{ fontWeight: 600 }}>&nbsp;</div>
            <div style={{ color: "#555" }}>Received by (payee signature)</div>
          </div>
        </div>

        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>
          System reference: {v.number} · ID {vid} — linked to requisition {v.reqNumber} in Project Strand.
        </div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton /></div>
      </div>
    </div>
  );
}
