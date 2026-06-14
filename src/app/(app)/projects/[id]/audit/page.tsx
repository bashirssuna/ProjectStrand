import { q } from "@/server/db";
import { SectionTitle, Empty, Badge } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { blockStaff } from "../_staffblock";

type Entry = { action: string; entity: string; entityId: string | null; createdAt: string; actor: string | null };

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await blockStaff(id);
  const entries = await q<Entry>(
    `SELECT a.action, a.entity, a.entity_id AS "entityId", a.created_at AS "createdAt", u.name AS actor
     FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id
     WHERE a.entity_id = $1
        OR a.entity_id IN (SELECT id FROM requisition WHERE project_id=$1)
        OR a.entity_id IN (SELECT id FROM activity WHERE project_id=$1)
        OR a.entity_id IN (SELECT id FROM project_document WHERE project_id=$1)
        OR a.entity_id IN (SELECT id FROM meeting WHERE project_id=$1)
        OR a.entity_id IN (SELECT id FROM risk_issue WHERE project_id=$1)
     ORDER BY a.created_at DESC LIMIT 150`, [id]
  );

  const tone = (a: string) => a === "create" ? "ok" : a === "delete" ? "danger" : a === "approve" ? "brand" : "info";

  return (
    <div className="space-y-4">
      <SectionTitle>Audit trail</SectionTitle>
      {entries.length === 0 ? (
        <Empty title="No audit entries yet" hint="Every create, update, approval and disbursement on this project is recorded here." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th">When</th><th className="th">Who</th><th className="th">Action</th><th className="th">Entity</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i}>
                  <td className="td whitespace-nowrap" style={{ color: "var(--muted)" }}>{fmtDateTime(e.createdAt)}</td>
                  <td className="td">{e.actor ?? "System"}</td>
                  <td className="td"><Badge tone={tone(e.action)}>{label(e.action)}</Badge></td>
                  <td className="td">{label(e.entity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs" style={{ color: "var(--muted)" }}>Showing the 150 most recent events for this project.</p>
    </div>
  );
}
