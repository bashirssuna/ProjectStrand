import { getProjectAccess } from "@/server/policy";
import { q } from "@/server/db";
import { addRiskAction, updateRiskStatusAction } from "@/app/actions";
import { SectionTitle, Empty, Badge, Field, severityTone } from "@/components/ui";
import { label } from "@/lib/enums";

type Risk = { id: string; kind: string; title: string; detail: string | null; severity: string; likelihood: string; status: string };

export default async function RisksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);
  const canEdit = access.permissions.has("project.edit");

  const risks = await q<Risk>(
    `SELECT id, kind, title, detail, severity, likelihood, status FROM risk_issue
     WHERE project_id=$1 ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, status`, [id]
  );
  const open = risks.filter((r) => r.status !== "closed");
  const closed = risks.filter((r) => r.status === "closed");

  const Row = ({ r }: { r: Risk }) => (
    <div className="card p-4 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge tone={r.kind === "issue" ? "danger" : "muted"}>{r.kind}</Badge>
          <Badge tone={severityTone(r.severity)}>{r.severity} severity</Badge>
          <Badge tone="muted">{r.likelihood} likelihood</Badge>
          <Badge tone={r.status === "closed" ? "ok" : r.status === "mitigating" ? "info" : "warn"}>{label(r.status)}</Badge>
        </div>
        <div className="font-medium mt-1.5">{r.title}</div>
        {r.detail && <div className="text-sm mt-0.5" style={{ color: "var(--muted)" }}>{r.detail}</div>}
      </div>
      {canEdit && (
        <form action={updateRiskStatusAction} className="flex items-center gap-2 shrink-0">
          <input type="hidden" name="projectId" value={id} />
          <input type="hidden" name="riskId" value={r.id} />
          <select name="status" defaultValue={r.status} className="select" style={{ width: 130 }}>
            <option value="open">Open</option>
            <option value="mitigating">Mitigating</option>
            <option value="closed">Closed</option>
          </select>
          <button className="btn btn-sm" type="submit">Update</button>
        </form>
      )}
    </div>
  );

  return (
    <div className="grid lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-4">
        <SectionTitle>Risk &amp; issue register</SectionTitle>
        {open.length === 0 ? <Empty title="No open risks or issues" hint="Log a risk on the right to start tracking it." />
          : open.map((r) => <Row key={r.id} r={r} />)}
        {closed.length > 0 && (
          <>
            <div className="text-xs font-medium uppercase tracking-wide mt-4" style={{ color: "var(--muted)" }}>Closed</div>
            {closed.map((r) => <Row key={r.id} r={r} />)}
          </>
        )}
      </div>

      {canEdit && (
        <form action={addRiskAction} className="card p-4 space-y-3 h-fit">
          <SectionTitle>Log a risk or issue</SectionTitle>
          <input type="hidden" name="projectId" value={id} />
          <Field label="Type">
            <select name="kind" className="select" defaultValue="risk"><option value="risk">Risk</option><option value="issue">Issue</option></select>
          </Field>
          <Field label="Title"><input name="title" required className="input" placeholder="e.g. Delayed disbursement from donor" /></Field>
          <Field label="Detail"><textarea name="detail" rows={2} className="textarea" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Severity">
              <select name="severity" className="select" defaultValue="medium"><option>high</option><option>medium</option><option>low</option></select>
            </Field>
            <Field label="Likelihood">
              <select name="likelihood" className="select" defaultValue="medium"><option>high</option><option>medium</option><option>low</option></select>
            </Field>
          </div>
          <button className="btn btn-primary w-full" type="submit">Add to register</button>
        </form>
      )}
    </div>
  );
}
