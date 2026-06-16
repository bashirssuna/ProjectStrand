import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";
import { financeAuditTrail, complianceFlags, changeSummary, type AuditFilters } from "@/server/services/finance_audit";

export default async function PrintFinanceAudit({ searchParams }: { searchParams: Promise<{ entity?: string; project?: string; from?: string; to?: string }> }) {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const sp = await searchParams;
  const filters: AuditFilters = { entity: sp.entity || null, projectId: sp.project || null, from: sp.from || null, to: sp.to || null };

  const projCode = filters.projectId ? (await one<{ code: string; title: string }>(`SELECT code, title FROM project WHERE id=$1 AND org_id=$2`, [filters.projectId, org.id])) : null;
  const flags = await complianceFlags(org.id);
  const trail = await financeAuditTrail(org.id, filters, 2000);
  const lh = await getLetterhead(org.id);

  const scope: string[] = [];
  if (sp.entity) scope.push(label(sp.entity));
  if (projCode) scope.push(`${projCode.code} — ${projCode.title}`);
  if (filters.from || filters.to) scope.push(`${filters.from ?? "start"} to ${filters.to ?? "today"}`);
  const scopeLine = scope.length ? scope.join(" · ") : "All financial transactions";

  const th: React.CSSProperties = { border: "1px solid #999", padding: "5px 8px", background: "#f0f0f0", textAlign: "left", fontSize: 11 };
  const td: React.CSSProperties = { border: "1px solid #ccc", padding: "5px 8px", fontSize: 11, verticalAlign: "top" };

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 980, margin: "0 auto", padding: "36px 28px", fontSize: 13 }}>
        <PrintLetterhead lh={lh} subtitle="Financial Audit & Compliance Report" />
        <div style={{ textAlign: "center", margin: "14px 0 4px", fontSize: 16, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1 }}>Financial Audit Trail</div>
        <div style={{ textAlign: "center", fontSize: 12, color: "#444", marginBottom: 16 }}>
          Scope: {scopeLine} · Generated {fmtDateTime(new Date().toISOString())}
        </div>

        <div style={{ fontWeight: 700, fontSize: 13, margin: "10px 0 6px" }}>Control checks ({flags.length} open)</div>
        {flags.length === 0 ? <p style={{ fontSize: 12, color: "#555" }}>No open control issues — all checked transactions are within budget, correctly posted and approved.</p> : (
          <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 18 }}>
            <thead><tr><th style={th}>Severity</th><th style={th}>Check</th><th style={th}>Finding</th><th style={th}>Project</th><th style={th}>When</th></tr></thead>
            <tbody>
              {flags.map((f) => (
                <tr key={f.id}>
                  <td style={{ ...td, textTransform: "uppercase", fontWeight: 600 }}>{f.severity}</td>
                  <td style={td}>{label(f.rule)}</td>
                  <td style={td}>{f.message}</td>
                  <td style={td}>{f.projectCode}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtDateTime(f.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ fontWeight: 700, fontSize: 13, margin: "10px 0 6px" }}>Audit trail ({trail.length} entries)</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr><th style={th}>When</th><th style={th}>Who</th><th style={th}>Action</th><th style={th}>Transaction</th><th style={th}>Project</th><th style={th}>Details</th></tr></thead>
          <tbody>
            {trail.map((e, i) => (
              <tr key={i}>
                <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtDateTime(e.createdAt)}</td>
                <td style={td}>{e.actor ?? "—"}</td>
                <td style={{ ...td, textTransform: "capitalize" }}>{label(e.action)}</td>
                <td style={td}>{label(e.entity)} {e.entityId ?? ""}</td>
                <td style={td}>{e.projectCode ?? "—"}</td>
                <td style={td}>{changeSummary(e.before, e.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p style={{ marginTop: 18, fontSize: 10.5, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>
          This report is generated from Project Strand&apos;s append-only audit log. Entries cannot be edited or deleted after the fact.
        </p>
        <div style={{ marginTop: 16 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
