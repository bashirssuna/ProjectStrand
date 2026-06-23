import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { budgetSummary } from "@/server/services/budget";
import { money, pct, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
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

  const overdue = await q<{ title: string; status: string; endDate: string | null }>(
    `SELECT title, status, end_date::text AS "endDate" FROM activity
     WHERE project_id=$1 AND type<>'milestone' AND status<>'done' AND end_date IS NOT NULL AND end_date < now() ORDER BY end_date`,
    [input.projectId]
  );
  const upcoming = await q<{ title: string; startDate: string | null; status: string }>(
    `SELECT title, start_date::text AS "startDate", status FROM activity
     WHERE project_id=$1 AND type<>'milestone' AND status<>'done' AND (end_date IS NULL OR end_date >= now())
     ORDER BY start_date NULLS LAST LIMIT 15`,
    [input.projectId]
  );
  const risks = await q<{ kind: string; title: string; severity: string; status: string }>(
    `SELECT kind, title, severity, status FROM risk_issue WHERE project_id=$1 AND status<>'closed' ORDER BY (severity='high') DESC, (severity='medium') DESC`,
    [input.projectId]
  );
  const reqs = await q<{ status: string; c: number; amt: number; disb: number }>(
    `SELECT status, COUNT(*)::int c, COALESCE(SUM(amount),0)::float8 amt, COALESCE(SUM(disbursed_amount),0)::float8 disb FROM requisition WHERE project_id=$1 GROUP BY status`,
    [input.projectId]
  );
  const reqTotal = reqs.reduce((a, r) => a + r.c, 0);
  const reqRequested = reqs.reduce((a, r) => a + r.amt, 0);
  const reqDisbursed = reqs.reduce((a, r) => a + r.disb, 0);

  const c = proj.currency;
  const sections: { key: string; title: string; content: string }[] = [
    {
      key: "summary", title: "Executive Summary",
      content: `During ${input.periodLabel}, ${proj.title} progressed with ${done.length} of ${acts.length} planned activities completed and ${inProgress.length} in progress.` +
        (overdue.length ? ` ${overdue.length} activit${overdue.length === 1 ? "y is" : "ies are"} behind schedule.` : "") +
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
      key: "delayed", title: "Delayed Activities",
      content: overdue.length ? overdue.map((a) => `• ${a.title} — due ${a.endDate ? fmtDate(a.endDate) : "—"} (${label(a.status)})`).join("\n") : "No activities are behind schedule.",
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
      key: "requisitions", title: "Requisitions",
      content: reqTotal ? `${reqTotal} requisition${reqTotal === 1 ? "" : "s"} totalling ${money(reqRequested, c)} requested, ${money(reqDisbursed, c)} disbursed.\n` +
        reqs.map((r) => `• ${label(r.status)}: ${r.c} (${money(r.amt, c)})`).join("\n") : "No requisitions raised.",
    },
    {
      key: "risks", title: "Risks, Issues & Flags",
      content: [
        ...risks.map((r) => `• [${label(r.kind)} · ${r.severity}] ${r.title} (${label(r.status)})`),
        ...flags.map((f) => `• [flag · ${f.severity}] ${f.message}`),
      ].join("\n") || "No open risks, issues or anomaly flags.",
    },
    {
      key: "next", title: "Next-Period Plans",
      content: upcoming.length ? upcoming.map((a) => `• ${a.title}${a.startDate ? ` — from ${fmtDate(a.startDate)}` : ""} (${label(a.status)})`).join("\n") : "No upcoming activities scheduled.",
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
