import "server-only";
import { q, one } from "@/server/db";
import { accountStats } from "./pettycash";
import { agreementStats } from "./funding";
import { reserveStats, investmentStats } from "./treasury";
import { reportStats } from "./whistleblower";
import { engagementStats } from "./auditreview";
import { caseStats } from "./er";
import { checklistStats } from "./checklists";
import { openingStats } from "./recruitment";
import { orgAppraisalStats } from "./appraisals";
import { listForecasts, getForecast, buildProjection } from "./cashflow";
import { surveyResults } from "./surveys";

export type Snapshot = Awaited<ReturnType<typeof institutionalSnapshot>>;

export async function institutionalSnapshot(orgId: string) {
  const [
    pettyCash, funding, reserves, investments, whistleblower, audit, er, checklists, recruitment, appraisals,
    baseRow, projAgg, overdueAct, flags, pendingReq, employees, surveyAgg, forecastRows,
  ] = await Promise.all([
    accountStats(orgId), agreementStats(orgId), reserveStats(orgId), investmentStats(orgId),
    reportStats(orgId), engagementStats(orgId), caseStats(orgId), checklistStats(orgId), openingStats(orgId), orgAppraisalStats(orgId),
    one<{ base: string }>(`SELECT base_currency AS base FROM organization WHERE id=$1`, [orgId]),
    one<{ total: number; active: number }>(`SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='active')::int active FROM project WHERE org_id=$1`, [orgId]),
    one<{ c: number }>(`SELECT COUNT(*)::int c FROM activity a JOIN project p ON p.id=a.project_id
                        WHERE p.org_id=$1 AND a.end_date IS NOT NULL AND a.end_date < now() AND COALESCE(a.progress,0) < 100`, [orgId]),
    one<{ open: number; critical: number }>(`SELECT COUNT(*) FILTER (WHERE resolved=false)::int open,
                        COUNT(*) FILTER (WHERE resolved=false AND severity='critical')::int critical
                        FROM anomaly_flag f JOIN project p ON p.id=f.project_id WHERE p.org_id=$1`, [orgId]),
    one<{ c: number }>(`SELECT COUNT(DISTINCT ra.requisition_id)::int c FROM requisition_approval ra
                        JOIN requisition r ON r.id=ra.requisition_id JOIN project p ON p.id=r.project_id
                        WHERE p.org_id=$1 AND ra.decision='pending'
                          AND r.status IN ('submitted','finance_review','pm_approval','admin_approval')`, [orgId]),
    one<{ c: number }>(`SELECT COUNT(*)::int c FROM employee WHERE org_id=$1 AND status <> 'terminated'`, [orgId]),
    one<{ openSurveys: number; latestId: string | null }>(
      `SELECT COUNT(*) FILTER (WHERE status='open')::int "openSurveys",
              (SELECT s.id FROM survey s WHERE s.org_id=$1 AND EXISTS (SELECT 1 FROM survey_response r WHERE r.survey_id=s.id)
               ORDER BY s.created_at DESC LIMIT 1) AS "latestId"
       FROM survey WHERE org_id=$1`, [orgId]),
    listForecasts(orgId),
  ]);

  // Cash-forecast shortfalls: project the active forecasts (bounded) and flag negatives.
  const activeForecasts = forecastRows.filter((f) => f.status === "active").slice(0, 10);
  let shortfallForecasts = 0; let worstLowest: number | null = null; let worstCurrency = baseRow?.base ?? "USD";
  for (const f of activeForecasts) {
    const detail = await getForecast(orgId, f.id);
    if (!detail) continue;
    const proj = await buildProjection(orgId, detail);
    if (proj.anyShortfall) shortfallForecasts += 1;
    if (worstLowest === null || proj.lowestClosing < worstLowest) { worstLowest = proj.lowestClosing; worstCurrency = detail.currency; }
  }

  // Latest survey engagement score
  let latestSurveyScore: number | null = null;
  if (surveyAgg?.latestId) latestSurveyScore = (await surveyResults(orgId, surveyAgg.latestId)).engagementScore;

  return {
    baseCurrency: baseRow?.base ?? "USD",
    projects: {
      total: projAgg?.total ?? 0, active: projAgg?.active ?? 0,
      overdueActivities: overdueAct?.c ?? 0, openFlags: flags?.open ?? 0, criticalFlags: flags?.critical ?? 0,
    },
    approvals: { pendingRequisitions: pendingReq?.c ?? 0 },
    finance: {
      pettyCash, funding, reserves, investments,
      cashForecast: { active: activeForecasts.length, shortfallForecasts, worstLowest, worstCurrency },
    },
    governance: { whistleblower, audit },
    hr: {
      employees: employees?.c ?? 0, recruitment, appraisals, er, checklists,
      survey: { openSurveys: surveyAgg?.openSurveys ?? 0, latestScore: latestSurveyScore },
    },
  };
}
