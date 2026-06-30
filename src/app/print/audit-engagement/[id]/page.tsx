import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { getEngagement, listFindings } from "@/server/services/auditreview";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

export default async function PrintAuditEngagement({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const e = await getEngagement(org.id, id);
  if (!e) redirect("/dashboard");
  const [findings, lh] = await Promise.all([listFindings(org.id, id), getLetterhead(org.id)]);

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 920, margin: "0 auto", padding: 32 }}>
        <div className="no-print" style={{ marginBottom: 12, textAlign: "right" }}><PrintButton /></div>
        <PrintLetterhead lh={lh} subtitle="Audit / Compliance Review — Findings & Action Plan" />

        <h2 style={{ fontSize: 16, fontWeight: 700, margin: "8px 0" }}>{e.title}</h2>
        <table style={{ width: "100%", fontSize: 13, marginBottom: 16 }}>
          <tbody>
            <tr><td style={{ padding: "2px 8px", color: "#555" }}>Type</td><td style={{ padding: "2px 8px" }}>{label(e.type)}</td>
                <td style={{ padding: "2px 8px", color: "#555" }}>Auditor</td><td style={{ padding: "2px 8px", fontWeight: 600 }}>{e.auditor ?? "—"}</td></tr>
            <tr><td style={{ padding: "2px 8px", color: "#555" }}>Fiscal year</td><td style={{ padding: "2px 8px" }}>{e.fiscalYear ?? "—"}</td>
                <td style={{ padding: "2px 8px", color: "#555" }}>Report date</td><td style={{ padding: "2px 8px" }}>{e.reportDate ? fmtDate(e.reportDate) : "—"}</td></tr>
            <tr><td style={{ padding: "2px 8px", color: "#555" }}>Period</td><td style={{ padding: "2px 8px" }}>{e.periodStart ? fmtDate(e.periodStart) : "—"} – {e.periodEnd ? fmtDate(e.periodEnd) : "—"}</td>
                <td style={{ padding: "2px 8px", color: "#555" }}>Opinion</td><td style={{ padding: "2px 8px" }}>{e.opinion ?? "—"}</td></tr>
            {e.scope && <tr><td style={{ padding: "2px 8px", color: "#555" }}>Scope</td><td style={{ padding: "2px 8px" }} colSpan={3}>{e.scope}</td></tr>}
          </tbody>
        </table>

        <h3 style={{ fontSize: 13, fontWeight: 700, margin: "16px 0 6px" }}>Findings &amp; recommendations ({e.implemented}/{e.total} resolved)</h3>
        {findings.length === 0 ? <p style={{ color: "#777", fontSize: 13 }}>No findings recorded.</p> : (
          <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: "2px solid #333" }}>
              <th style={{ textAlign: "left", padding: 5 }}>Ref</th><th style={{ textAlign: "left", padding: 5 }}>Finding</th>
              <th style={{ textAlign: "left", padding: 5 }}>Area</th><th style={{ textAlign: "left", padding: 5 }}>Risk</th>
              <th style={{ textAlign: "left", padding: 5 }}>Responsible</th><th style={{ textAlign: "left", padding: 5 }}>Target</th>
              <th style={{ textAlign: "left", padding: 5 }}>Status</th>
            </tr></thead>
            <tbody>
              {findings.map((x) => (
                <tr key={x.id} style={{ borderBottom: "1px solid #ddd" }}>
                  <td style={{ padding: 5, whiteSpace: "nowrap", fontFamily: "monospace" }}>{x.ref}</td>
                  <td style={{ padding: 5 }}>{x.title}</td>
                  <td style={{ padding: 5 }}>{x.area ?? "—"}</td>
                  <td style={{ padding: 5 }}>{label(x.risk)}</td>
                  <td style={{ padding: 5 }}>{x.responsible ?? "—"}</td>
                  <td style={{ padding: 5, whiteSpace: "nowrap" }}>{x.targetDate ? fmtDate(x.targetDate) : "—"}{x.overdue ? " (overdue)" : ""}</td>
                  <td style={{ padding: 5 }}>{label(x.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ marginTop: 40, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
          <div>Management sign-off: __________________________</div>
          <div>Date: ______________</div>
        </div>
      </div>
    </div>
  );
}
