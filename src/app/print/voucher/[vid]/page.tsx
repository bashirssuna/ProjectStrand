import { redirect } from "next/navigation";
import { one } from "@/server/db";
import { requireUser } from "@/server/auth";
import { getProjectAccess } from "@/server/policy";
import { getUserOrg } from "@/server/services/accounts";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

// Print-friendly payment voucher on the institution's letterhead. Works for both
// requisition-linked vouchers (three-stage sign-off) and standalone vouchers.
export default async function PrintVoucherPage({ params }: { params: Promise<{ vid: string }> }) {
  const { vid } = await params;
  const user = await requireUser();
  const v = await one<{
    projectId: string | null; orgId: string; number: string; payee: string; amount: number; method: string;
    reference: string | null; purpose: string | null; voucherDate: string; status: string;
    preparedByName: string | null; preparedById: string | null; preparedAt: string;
    checkedByName: string | null; checkedById: string | null; checkedAt: string | null;
    approvedByName: string | null; approvedById: string | null; approvedAt: string | null;
    reqNumber: string | null; reqTitle: string | null; projectTitle: string | null; projectCode: string | null; currency: string;
  }>(
    `SELECT pv.project_id AS "projectId", COALESCE(pv.org_id, p.org_id) AS "orgId", pv.number, pv.payee, pv.amount, pv.method, pv.reference,
            pv.purpose, COALESCE(pv.voucher_date::text, pv.created_at::text) AS "voucherDate", COALESCE(pv.status,'prepared') AS status,
            pv.prepared_by_name AS "preparedByName", pv.prepared_by AS "preparedById", pv.created_at AS "preparedAt",
            pv.checked_by_name AS "checkedByName", pv.checked_by AS "checkedById", pv.checked_at AS "checkedAt",
            pv.approved_by_name AS "approvedByName", pv.approved_by AS "approvedById", pv.approved_at AS "approvedAt",
            r.number AS "reqNumber", r.title AS "reqTitle",
            p.title AS "projectTitle", p.code AS "projectCode", COALESCE(p.currency, o.base_currency, 'USD') AS currency
     FROM payment_voucher pv
     LEFT JOIN requisition r ON r.id=pv.requisition_id
     LEFT JOIN project p ON p.id=pv.project_id
     LEFT JOIN organization o ON o.id=COALESCE(pv.org_id, p.org_id)
     WHERE pv.id=$1`, [vid]
  );
  if (!v) redirect("/dashboard");
  // Authorise: project members (with view) for project vouchers; org admins for standalone.
  if (v.projectId) {
    const access = await getProjectAccess(v.projectId);
    if (!access.permissions.has("project.view")) redirect("/dashboard");
  } else {
    const org = await getUserOrg(user.id);
    if (!org || org.id !== v.orgId || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  }

  async function sigFor(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    const r = await one<{ s: string }>(`SELECT data_url AS s FROM signature_asset WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [userId]);
    return r?.s ?? null;
  }
  const stages = [
    { label: "Prepared by", name: v.preparedByName, at: v.preparedAt, sig: await sigFor(v.preparedById) },
    { label: "Checked by", name: v.checkedByName, at: v.checkedAt, sig: await sigFor(v.checkedById) },
    { label: "Approved by", name: v.approvedByName, at: v.approvedAt, sig: await sigFor(v.approvedById) },
  ];

  const lh = await getLetterhead(v.orgId);
  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <PrintLetterhead lh={lh} subtitle={v.projectCode ? `Project: ${v.projectCode} — ${v.projectTitle}` : undefined} />

        <div style={{ textAlign: "center", margin: "18px 0 6px", fontSize: 17, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>
          Payment Voucher
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#444", marginBottom: 4 }}>
          <span>No: <strong style={{ color: "#111" }}>{v.number}</strong></span>
          <span>Date: {fmtDate(v.voucherDate)}</span>
          {v.reqNumber && <span>Requisition: {v.reqNumber}</span>}
        </div>
        <div style={{ textAlign: "center", marginBottom: 14, fontSize: 12 }}>
          Status: <strong>{label(v.status)}</strong>
          {(v.status === "approved" || v.status === "paid") && v.approvedAt ? <> · Paid on {fmtDate(v.approvedAt)}</> : v.status === "paid" ? <> · Paid</> : <> · <em>payment pending approval</em></>}
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <tbody>
            {[
              ["Pay to", v.payee],
              ["Purpose", v.purpose ?? v.reqTitle ?? "—"],
              ["Project", v.projectCode ? `${v.projectCode} — ${v.projectTitle}` : "—"],
              ["Payment method", label(v.method)],
              ["Reference", v.reference ?? "—"],
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

        {/* Sign-off */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, marginTop: 34 }}>
          {stages.map((st) => (
            <div key={st.label} style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12 }}>
              {st.sig ? <img src={st.sig} alt="" style={{ height: 36, marginBottom: 4 }} /> : <div style={{ height: 40 }} />}
              <div style={{ fontWeight: 600 }}>{st.name || "\u00A0"}</div>
              <div style={{ color: "#555" }}>{st.label}</div>
              <div style={{ color: "#888", fontSize: 11 }}>{st.at ? fmtDate(st.at) : ""}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 24, borderTop: "1px solid #111", paddingTop: 6, fontSize: 12, maxWidth: 240 }}>
          <div style={{ height: 40 }} />
          <div style={{ fontWeight: 600 }}>&nbsp;</div>
          <div style={{ color: "#555" }}>Received by (payee signature &amp; date)</div>
        </div>

        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>
          System reference: {v.number}{v.reqNumber ? ` · linked to requisition ${v.reqNumber}` : ""} · generated from Project Strand.
        </div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
