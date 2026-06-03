import "server-only";
import { q, one } from "@/server/db";
import { id } from "@/lib/ids";
import { budgetSummary } from "@/server/services/budget";
import { writeAudit } from "@/server/services/audit";

export type ProjectRow = {
  id: string; code: string; title: string; status: string; mode: string;
  donor: string | null; currency: string; startDate: string | null; endDate: string | null;
  role: string | null;
};

// Projects the user can see: explicit membership, or everything for admins.
export async function listProjectsForUser(userId: string, isSuperAdmin: boolean): Promise<ProjectRow[]> {
  // Platform operator (super admin) sees every organisation's projects.
  if (isSuperAdmin) {
    return q<ProjectRow>(
      `SELECT p.id, p.code, p.title, p.status, p.mode, p.donor, p.currency,
              p.start_date AS "startDate", p.end_date AS "endDate",
              (SELECT role FROM project_member WHERE project_id=p.id AND user_id=$1) AS role
       FROM project p ORDER BY p.created_at DESC`,
      [userId]
    );
  }
  // Everyone else is scoped to their organisation:
  //  - org admins see ALL projects in orgs where they hold the org_admin role;
  //  - other members see only the projects they belong to.
  return q<ProjectRow>(
    `SELECT DISTINCT p.id, p.code, p.title, p.status, p.mode, p.donor, p.currency,
            p.start_date AS "startDate", p.end_date AS "endDate",
            (SELECT role FROM project_member WHERE project_id=p.id AND user_id=$1) AS role
     FROM project p
     WHERE p.id IN (SELECT project_id FROM project_member WHERE user_id=$1)
        OR p.org_id IN (
          SELECT m.org_id FROM org_membership m JOIN role r ON r.id=m.role_id
          WHERE m.user_id=$1 AND r.key='org_admin'
        )
     ORDER BY p.created_at DESC`,
    [userId]
  );
}

export type ProjectSummary = {
  project: {
    id: string; code: string; title: string; summary: string | null; status: string;
    mode: string; donor: string | null; grantNumber: string | null; currency: string;
    startDate: string | null; endDate: string | null;
  };
  budget: { id: string; planned: number; committed: number; actual: number; remaining: number; burn: number } | null;
  counts: {
    activities: number; activitiesDone: number; members: number; documents: number;
    openRequisitions: number; objectives: number; openFlags: number;
  };
  timePct: number;
  progressPct: number;
};

export async function getProjectSummary(projectId: string): Promise<ProjectSummary | null> {
  const project = await one<ProjectSummary["project"]>(
    `SELECT id, code, title, summary, status, mode, donor, grant_number AS "grantNumber",
            currency, start_date AS "startDate", end_date AS "endDate"
     FROM project WHERE id = $1`,
    [projectId]
  );
  if (!project) return null;

  const bud = await one<{ id: string }>(
    `SELECT id FROM budget WHERE project_id = $1 ORDER BY version DESC LIMIT 1`, [projectId]
  );
  const budget = bud ? { id: bud.id, ...(await budgetSummary(bud.id)) } : null;

  const c = await one<{
    activities: number; done: number; members: number; documents: number;
    openreqs: number; objectives: number; flags: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM activity WHERE project_id=$1) AS activities,
       (SELECT COUNT(*)::int FROM activity WHERE project_id=$1 AND status='done') AS done,
       (SELECT COUNT(*)::int FROM project_member WHERE project_id=$1) AS members,
       (SELECT COUNT(*)::int FROM project_document WHERE project_id=$1) AS documents,
       (SELECT COUNT(*)::int FROM requisition WHERE project_id=$1 AND status NOT IN ('retired','closed','rejected','disbursed')) AS openreqs,
       (SELECT COUNT(*)::int FROM objective WHERE project_id=$1) AS objectives,
       (SELECT COUNT(*)::int FROM anomaly_flag WHERE project_id=$1 AND resolved=false) AS flags`,
    [projectId]
  );

  const prog = await one<{ avg: number }>(
    `SELECT COALESCE(AVG(progress),0)::float AS avg FROM activity WHERE project_id=$1 AND type<>'milestone'`,
    [projectId]
  );

  let timePct = 0;
  if (project.startDate && project.endDate) {
    const s = new Date(project.startDate).getTime();
    const e = new Date(project.endDate).getTime();
    const now = Date.now();
    timePct = e > s ? Math.min(100, Math.max(0, ((now - s) / (e - s)) * 100)) : 0;
  }

  return {
    project,
    budget,
    counts: {
      activities: c?.activities ?? 0, activitiesDone: c?.done ?? 0,
      members: c?.members ?? 0, documents: c?.documents ?? 0,
      openRequisitions: c?.openreqs ?? 0, objectives: c?.objectives ?? 0,
      openFlags: c?.flags ?? 0,
    },
    timePct,
    progressPct: Math.round(prog?.avg ?? 0),
  };
}

// Simple composite health: schedule adherence, budget discipline, risk flags.
export function healthScore(s: ProjectSummary): { score: number; tone: "ok" | "warn" | "danger"; label: string } {
  let score = 100;
  if (s.budget && s.budget.burn > s.timePct + 15) score -= 20; // spending ahead of schedule
  if (s.timePct > s.progressPct + 15) score -= 20;             // behind schedule
  score -= Math.min(30, s.counts.openFlags * 10);
  score = Math.max(0, Math.round(score));
  const tone = score >= 75 ? "ok" : score >= 50 ? "warn" : "danger";
  const label = tone === "ok" ? "On track" : tone === "warn" ? "Needs attention" : "At risk";
  return { score, tone, label };
}

export async function createProject(input: {
  orgId: string; userId: string; code: string; title: string; summary?: string;
  donor?: string; grantNumber?: string; currency?: string; mode?: string;
  startDate?: string; endDate?: string; addCreatorAsPi?: boolean;
}): Promise<string> {
  const pid = id("prj");
  await q(
    `INSERT INTO project (id, org_id, code, title, summary, donor, grant_number, currency, mode, status, start_date, end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10,$11)`,
    [pid, input.orgId, input.code, input.title, input.summary ?? null, input.donor ?? null,
     input.grantNumber ?? null, input.currency ?? "USD", input.mode ?? "advanced",
     input.startDate ?? null, input.endDate ?? null]
  );
  // status starts as 'draft'
  // The creating PI becomes owner. Admins do NOT become members (they oversee
  // all projects but must not hold operational requisition/report powers).
  if (input.addCreatorAsPi !== false) {
    await q(
      `INSERT INTO project_member (id, project_id, user_id, role) VALUES ($1,$2,$3,'pi')`,
      [id("pm"), pid, input.userId]
    );
  }
  await writeAudit({ orgId: input.orgId, userId: input.userId, action: "create", entity: "project", entityId: pid, after: { code: input.code, title: input.title } });
  return pid;
}
