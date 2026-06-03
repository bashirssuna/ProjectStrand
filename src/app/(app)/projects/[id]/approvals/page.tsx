import Link from "next/link";
import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { SectionTitle, Empty, Badge } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

type Req = { id: string; number: string; title: string; amount: number; status: string };
type Appr = { reqId: string; step: number; role: string; decision: string; approverName: string | null; decidedAt: string | null };

export default async function ApprovalsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);

  const project = await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [id]);
  const reqs = await q<Req>(`SELECT id, number, title, amount, status FROM requisition WHERE project_id=$1 ORDER BY created_at DESC`, [id]);
  const apprs = await q<Appr>(
    `SELECT ra.requisition_id AS "reqId", ra.step, ra.role, ra.decision, ra.decided_at AS "decidedAt", u.name AS "approverName"
     FROM requisition_approval ra JOIN requisition r ON r.id=ra.requisition_id
     LEFT JOIN app_user u ON u.id=ra.approver_id
     WHERE r.project_id=$1 ORDER BY ra.requisition_id, ra.step`, [id]
  );
  const byReq = new Map<string, Appr[]>();
  for (const a of apprs) { (byReq.get(a.reqId) ?? byReq.set(a.reqId, []).get(a.reqId)!).push(a); }

  const pending = reqs.filter((r) => ["submitted", "under_review", "pending_approval", "awaiting_approval"].includes(r.status) || (byReq.get(r.id) ?? []).some((a) => a.decision === "pending"));
  const pendingSet = new Set(pending.map((r) => r.id));
  const decided = reqs.filter((r) => !pendingSet.has(r.id));

  const sow = await one<{ status: string; approvedAt: string | null; approver: string | null }>(
    `SELECT s.status, s.approved_at AS "approvedAt", u.name AS approver FROM sow s LEFT JOIN app_user u ON u.id=s.approved_by_id WHERE s.project_id=$1`, [id]
  );

  const decisionTone = (d: string) => d === "approved" ? "ok" : d === "rejected" ? "danger" : "warn";

  const Card = ({ r }: { r: Req }) => {
    const chain = byReq.get(r.id) ?? [];
    return (
      <Link href={`/projects/${id}/requisitions/${r.id}`} className="card p-4 block hover:border-[var(--brand)] transition-colors">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{r.number}</span>
            <div className="font-medium">{r.title}</div>
          </div>
          <div className="text-right">
            <div className="tabular-nums font-medium">{money(r.amount, project?.currency)}</div>
            <Badge tone="muted">{label(r.status)}</Badge>
          </div>
        </div>
        {chain.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
            {chain.map((a, i) => (
              <Badge key={i} tone={decisionTone(a.decision)}>
                {label(a.role)}: {a.decision === "pending" ? "awaiting" : a.decision}{a.approverName ? ` · ${a.approverName}` : ""}
              </Badge>
            ))}
          </div>
        )}
      </Link>
    );
  };

  return (
    <div className="space-y-6">
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Statement of Work</div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              {sow ? (sow.status === "approved" ? `Approved${sow.approver ? ` by ${sow.approver}` : ""}${sow.approvedAt ? ` on ${fmtDate(sow.approvedAt)}` : ""}` : "Awaiting PI approval") : "No SOW created yet"}
            </div>
          </div>
          <Badge tone={sow?.status === "approved" ? "ok" : "warn"}>{label(sow?.status ?? "none")}</Badge>
        </div>
      </div>

      <div>
        <SectionTitle action={access.permissions.has("requisitions.approve") ? <span className="text-xs" style={{ color: "var(--muted)" }}>You can approve — open a requisition to sign off</span> : undefined}>
          Awaiting approval
        </SectionTitle>
        {pending.length === 0 ? <Empty title="Nothing awaiting approval" hint="Submitted requisitions that need a decision appear here." />
          : <div className="space-y-3">{pending.map((r) => <Card key={r.id} r={r} />)}</div>}
      </div>

      {decided.length > 0 && (
        <div>
          <SectionTitle>Decided &amp; drafts</SectionTitle>
          <div className="space-y-3">{decided.map((r) => <Card key={r.id} r={r} />)}</div>
        </div>
      )}
    </div>
  );
}
