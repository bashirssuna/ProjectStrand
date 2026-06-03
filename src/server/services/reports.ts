import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { budgetSummary } from "@/server/services/budget";
import { money, pct } from "@/lib/format";
import { writeAudit } from "@/server/services/audit";

// Builds a draft report from live project data. AI_PROVIDER="anthropic" would
// replace the section bodies with an LLM pass over the same inputs.
export async function generateReport(input: {
  projectId: string; userId: string; type: string; periodLabel: string;
}): Promise<string> {
  const proj = await one<{ title: string; currency: string; orgId: string }>(
    `SELECT title, currency, org_id AS "orgId" FROM project WHERE id=$1`, [input.projectId]
  );
  if (!proj) throw new Error("Project not found");

  const acts = await q<{ title: string; status: string; progress: number }>(
    `SELECT title, status, progress FROM activity WHERE project_id=$1 AND type<>'milestone' ORDER BY "order"`,
    [input.projectId]
  );
  const done = acts.filter((a) => a.status === "done");
  const inProgress = acts.filter((a) => a.status === "in_progress");
  const blocked = acts.filter((a) => a.status === "blocked");

  const bud = await one<{ id: string }>(`SELECT id FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [input.projectId]);
  const bs = bud ? await budgetSummary(bud.id) : null;

  const inds = await q<{ name: string; target: number; unit: string; latest: number }>(
    `SELECT i.name, i.target, i.unit,
            COALESCE((SELECT value FROM indicator_actual WHERE indicator_id=i.id ORDER BY recorded_at DESC LIMIT 1),0) AS latest
     FROM indicator i
     JOIN objective o ON o.id = i.objective_id
     WHERE o.project_id = $1`,
    [input.projectId]
  );

  const flags = await q<{ message: string; severity: string }>(
    `SELECT message, severity FROM anomaly_flag WHERE project_id=$1 AND resolved=false ORDER BY severity`,
    [input.projectId]
  );

  const c = proj.currency;
  const sections: { key: string; title: string; content: string }[] = [
    {
      key: "summary", title: "Executive Summary",
      content: `During ${input.periodLabel}, ${proj.title} progressed with ${done.length} of ${acts.length} planned activities completed and ${inProgress.length} in progress.` +
        (bs ? ` Budget utilisation stands at ${pct(bs.burn)} (${money(bs.actual, c)} of ${money(bs.planned, c)}).` : "") +
        (blocked.length ? ` ${blocked.length} activities are currently blocked and require attention.` : " No activities are blocked."),
    },
    {
      key: "achievements", title: "Key Achievements",
      content: done.length ? done.map((a) => `• Completed: ${a.title}`).join("\n") : "No activities were fully completed in this period.",
    },
    {
      key: "ongoing", title: "Activities In Progress",
      content: inProgress.length ? inProgress.map((a) => `• ${a.title} (${a.progress}%)`).join("\n") : "No activities currently in progress.",
    },
    {
      key: "indicators", title: "Progress Against Indicators",
      content: inds.length ? inds.map((i) => `• ${i.name}: ${i.latest}/${i.target} ${i.unit} (${pct(i.target > 0 ? (i.latest / i.target) * 100 : 0)})`).join("\n") : "No indicators defined.",
    },
    {
      key: "budget", title: "Financial Summary",
      content: bs ? `Planned: ${money(bs.planned, c)}\nCommitted: ${money(bs.committed, c)}\nSpent: ${money(bs.actual, c)}\nRemaining: ${money(bs.remaining, c)}\nBurn rate: ${pct(bs.burn)}` : "No budget recorded.",
    },
    {
      key: "risks", title: "Risks & Flags",
      content: flags.length ? flags.map((f) => `• [${f.severity}] ${f.message}`).join("\n") : "No outstanding anomaly flags.",
    },
  ];

  const reportId = id("rep");
  await q(
    `INSERT INTO report (id, project_id, type, title, period_label, status, generated_by_ai)
     VALUES ($1,$2,$3,$4,$5,'draft',true)`,
    [reportId, input.projectId, input.type, `${input.type[0].toUpperCase() + input.type.slice(1)} Report — ${input.periodLabel}`, input.periodLabel]
  );
  let order = 0;
  for (const s of sections) {
    await q(`INSERT INTO report_section (id, report_id, key, title, content, "order") VALUES ($1,$2,$3,$4,$5,$6)`,
      [id("rsec"), reportId, s.key, s.title, s.content, order++]);
  }
  await writeAudit({ orgId: proj.orgId, userId: input.userId, action: "create", entity: "report", entityId: reportId, after: { period: input.periodLabel } });
  return reportId;
}
