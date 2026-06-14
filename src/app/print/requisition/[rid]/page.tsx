import { redirect } from "next/navigation";
import { q, one } from "@/server/db";
import { getProjectAccess } from "@/server/policy";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

// Print-friendly requisition on the institution's letterhead (use the browser's
// Print → Save as PDF for the physical archive copy).
export default async function PrintRequisitionPage({ params }: { params: Promise<{ rid: string }> }) {
  const { rid } = await params;
  const meta = await one<{ projectId: string }>(`SELECT project_id AS "projectId" FROM requisition WHERE id=$1`, [rid]);
  if (!meta) redirect("/dashboard");
  const access = await getProjectAccess(meta.projectId);
  if (!access.permissions.has("project.view")) redirect("/dashboard");

  const req = (await one<{
    number: string; title: string; amount: number; status: string; justification: string | null;
    neededBy: string | null; payee: string | null; createdAt: string; requester: string | null;
    budgetLine: string | null; projectTitle: string; projectCode: string; currency: string; org: string; orgId: string;
  }>(
    `SELECT r.number, r.title, r.amount, r.status, r.justification, r.needed_by AS "neededBy",
            r.payee, r.created_at AS "createdAt",
            (SELECT name FROM app_user WHERE id=r.requested_by_id) AS requester,
            (SELECT code || ' — ' || description FROM budget_line WHERE id=r.budget_line_id) AS "budgetLine",
            p.title AS "projectTitle", p.code AS "projectCode", p.currency, o.name AS org, p.org_id AS "orgId"
     FROM requisition r JOIN project p ON p.id=r.project_id JOIN organization o ON o.id=p.org_id
     WHERE r.id=$1`, [rid]
  ))!;
  const activities = await q<{ code: string | null; title: string }>(
    `SELECT a.code, a.title FROM requisition_activity ra JOIN activity a ON a.id=ra.activity_id WHERE ra.requisition_id=$1
     UNION SELECT a.code, a.title FROM requisition r JOIN activity a ON a.id=r.activity_id WHERE r.id=$1 AND r.activity_id IS NOT NULL`, [rid]
  );
  const approvals = await q<{ step: number; role: string; decision: string; decidedAt: string | null; approver: string | null; signature: string | null; comment: string | null }>(
    `SELECT ra.step, ra.role, ra.decision, ra.decided_at AS "decidedAt", u.name AS approver, ra.comment,
            (SELECT data_url FROM signature_asset WHERE user_id=ra.approver_id ORDER BY created_at DESC LIMIT 1) AS signature
     FROM requisition_approval ra LEFT JOIN app_user u ON u.id=ra.approver_id
     WHERE ra.requisition_id=$1 ORDER BY ra.step`, [rid]
  );
  const vouchers = await q<{ number: string; payee: string; amount: number; method: string; reference: string | null }>(
    `SELECT number, payee, amount, method, reference FROM payment_voucher WHERE requisition_id=$1 ORDER BY created_at`, [rid]
  );
  const c = req.currency;

  const lh = await getLetterhead(req.orgId);
  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <PrintLetterhead lh={lh} subtitle={`Project: ${req.projectCode} — ${req.projectTitle}`} />

        <div style={{ textAlign: "center", margin: "18px 0 6px", fontSize: 17, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
          Fund Requisition
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#444", marginBottom: 14 }}>
          <span>No: <strong style={{ color: "#111" }}>{req.number}</strong></span>
          <span>Date raised: {fmtDate(req.createdAt)}</span>
          <span>Status: {label(req.status)}</span>
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {[
              ["Title / purpose", req.title],
              ["Requested by", req.requester ?? "—"],
              ["Payee", req.payee ?? "—"],
              ["Budget line", req.budgetLine ?? "—"],
              ["Activities covered", activities.length ? activities.map((a) => `${a.code ? a.code + " " : ""}${a.title}`).join("; ") : "—"],
              ["Needed by", fmtDate(req.neededBy)],
              ["Justification", req.justification ?? "—"],
            ].map(([k, v]) => (
              <tr key={k as string}>
                <td style={{ border: "1px solid #999", padding: "7px 10px", width: 180, fontWeight: 600, background: "#f5f5f5" }}>{k}</td>
                <td style={{ border: "1px solid #999", padding: "7px 10px" }}>{v}</td>
              </tr>
            ))}
            <tr>
              <td style={{ border: "1px solid #999", padding: "7px 10px", fontWeight: 700, background: "#f5f5f5" }}>Amount requested</td>
              <td style={{ border: "1px solid #999", padding: "7px 10px", fontWeight: 700, fontSize: 16 }}>{money(req.amount, c)}</td>
            </tr>
          </tbody>
        </table>

        {/* Approval chain with signatures */}
        <div style={{ marginTop: 22, fontWeight: 700 }}>Approvals</div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
          <thead>
            <tr>
              {["Step", "Role", "Name", "Decision", "Date", "Signature"].map((h) => (
                <th key={h} style={{ border: "1px solid #999", padding: "6px 8px", background: "#f5f5f5", textAlign: "left", fontSize: 12 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {approvals.map((a) => (
              <tr key={a.step}>
                <td style={{ border: "1px solid #999", padding: "6px 8px" }}>{a.step}</td>
                <td style={{ border: "1px solid #999", padding: "6px 8px" }}>{label(a.role)}</td>
                <td style={{ border: "1px solid #999", padding: "6px 8px" }}>{a.approver ?? ""}</td>
                <td style={{ border: "1px solid #999", padding: "6px 8px" }}>{label(a.decision)}{a.comment ? ` — ${a.comment}` : ""}</td>
                <td style={{ border: "1px solid #999", padding: "6px 8px", whiteSpace: "nowrap" }}>{a.decidedAt ? fmtDateTime(a.decidedAt) : ""}</td>
                <td style={{ border: "1px solid #999", padding: "4px 8px", height: 46 }}>
                  {a.signature && a.decision === "approved" ? <img src={a.signature} alt="" style={{ height: 38 }} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {vouchers.length > 0 && (
          <>
            <div style={{ marginTop: 22, fontWeight: 700 }}>Disbursement vouchers</div>
            <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
              <thead>
                <tr>{["Voucher", "Payee", "Method", "Reference", "Amount"].map((h) => (
                  <th key={h} style={{ border: "1px solid #999", padding: "6px 8px", background: "#f5f5f5", textAlign: "left", fontSize: 12 }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {vouchers.map((v) => (
                  <tr key={v.number}>
                    <td style={{ border: "1px solid #999", padding: "6px 8px" }}>{v.number}</td>
                    <td style={{ border: "1px solid #999", padding: "6px 8px" }}>{v.payee}</td>
                    <td style={{ border: "1px solid #999", padding: "6px 8px" }}>{label(v.method)}</td>
                    <td style={{ border: "1px solid #999", padding: "6px 8px" }}>{v.reference ?? ""}</td>
                    <td style={{ border: "1px solid #999", padding: "6px 8px" }}>{money(v.amount, c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>
          System reference: {req.number} · ID {rid} — attach this number to the physical copy to link it with the record in Project Strand.
        </div>

        <div style={{ marginTop: 18 }} className="no-print"><PrintButton /></div>
      </div>
    </div>
  );
}
