import { redirect } from "next/navigation";
import { getProjectSummary, healthScore } from "@/server/services/projects";
import { getProjectAccess } from "@/server/policy";
import { q } from "@/server/db";
import { resolveFlagAction, setProjectStatusAction } from "@/app/actions";
import { Stat, Badge, ProgressBar, SectionTitle, Empty, severityTone } from "@/components/ui";
import { money, pct, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

export default async function ProjectOverview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);
  const summary = await getProjectSummary(id);
  if (!summary) redirect("/projects");
  const h = healthScore(summary);
  const c = summary.project.currency;
  const canManageBudget = access.permissions.has("budget.manage");

  const flags = await q<{ id: string; rule: string; severity: string; message: string; createdAt: string }>(
    `SELECT id, rule, severity, message, created_at AS "createdAt"
     FROM anomaly_flag WHERE project_id=$1 AND resolved=false ORDER BY
       CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC`, [id]
  );
  const risks = await q<{ id: string; title: string; severity: string; status: string; kind: string }>(
    `SELECT id, title, severity, status, kind FROM risk_issue WHERE project_id=$1 AND status<>'closed' ORDER BY severity`, [id]
  );

  return (
    <div className="space-y-7">
      {access.permissions.has("project.administer") && (
        <div className="flex justify-end">
          <form action={setProjectStatusAction} className="flex items-end gap-2">
            <input type="hidden" name="projectId" value={id} />
            <div>
              <span className="label">Project status</span>
              <select name="status" defaultValue={summary.project.status} className="select" style={{ width: 160 }}>
                <option value="active">Active</option>
                <option value="on_hold">On Hold</option>
                <option value="completed">Completed</option>
                <option value="draft">Draft</option>
                <option value="archived">Archived</option>
              </select>
            </div>
            <button className="btn" type="submit">Update status</button>
          </form>
        </div>
      )}
      {summary.project.summary && (
        <p className="text-sm leading-relaxed" style={{ color: "var(--muted)" }}>{summary.project.summary}</p>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Progress" value={pct(summary.progressPct)} sub={`${summary.counts.activitiesDone}/${summary.counts.activities} activities done`} />
        <Stat label="Timeline elapsed" value={pct(summary.timePct)} sub={`${fmtDate(summary.project.startDate)} → ${fmtDate(summary.project.endDate)}`} />
        <Stat label="Budget burn" value={summary.budget ? pct(summary.budget.burn) : "—"}
          sub={summary.budget ? `${money(summary.budget.actual, c)} of ${money(summary.budget.planned, c)}` : "no budget"}
          tone={summary.budget && summary.budget.burn > summary.timePct + 15 ? "danger" : undefined} />
        <Stat label="Open flags" value={summary.counts.openFlags} sub={`${summary.counts.openRequisitions} open requisitions`} tone={summary.counts.openFlags ? "danger" : "ok"} />
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="card p-5">
          <div className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>Project health</div>
          <div className="flex items-end gap-3 mt-2">
            <div className="kpi" style={{ color: `var(--${h.tone === "ok" ? "ok" : h.tone === "warn" ? "warn" : "danger"})` }}>{h.score}</div>
            <Badge tone={h.tone}>{h.label}</Badge>
          </div>
          <div className="mt-4 space-y-3">
            <div>
              <div className="flex justify-between text-xs mb-1"><span style={{ color: "var(--muted)" }}>Schedule vs progress</span></div>
              <ProgressBar value={summary.progressPct} tone={summary.timePct > summary.progressPct + 15 ? "warn" : "brand"} />
            </div>
            {summary.budget && (
              <div>
                <div className="flex justify-between text-xs mb-1"><span style={{ color: "var(--muted)" }}>Budget burn</span></div>
                <ProgressBar value={summary.budget.burn} tone={summary.budget.burn > summary.timePct + 15 ? "danger" : "ok"} />
              </div>
            )}
          </div>
        </div>

        <div className="card p-5 lg:col-span-2">
          <SectionTitle>Anomaly flags</SectionTitle>
          {flags.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>No outstanding flags. Spending and budgets look consistent.</p>
          ) : (
            <div className="space-y-2">
              {flags.map((f) => (
                <div key={f.id} className="flex items-start justify-between gap-3 py-2 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
                  <div className="flex items-start gap-2 min-w-0">
                    <Badge tone={severityTone(f.severity)}>{label(f.rule)}</Badge>
                    <div className="text-sm min-w-0">{f.message}</div>
                  </div>
                  {canManageBudget && (
                    <form action={resolveFlagAction}>
                      <input type="hidden" name="projectId" value={id} />
                      <input type="hidden" name="flagId" value={f.id} />
                      <button className="btn btn-sm" type="submit">Resolve</button>
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div>
        <SectionTitle>Risks &amp; issues</SectionTitle>
        {risks.length === 0 ? (
          <Empty title="No open risks" hint="Risks and issues raised on the project will appear here." />
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Title</th><th className="th text-left">Type</th>
                <th className="th text-left">Severity</th><th className="th text-left">Status</th>
              </tr></thead>
              <tbody>
                {risks.map((r) => (
                  <tr key={r.id}>
                    <td className="td">{r.title}</td>
                    <td className="td">{label(r.kind)}</td>
                    <td className="td"><Badge tone={severityTone(r.severity === "high" ? "critical" : r.severity === "medium" ? "warning" : "info")}>{label(r.severity)}</Badge></td>
                    <td className="td">{label(r.status)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
