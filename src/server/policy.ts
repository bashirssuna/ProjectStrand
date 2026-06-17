import "server-only";
import { one } from "@/server/db";
import { ROLE_PERMISSIONS, type Permission, type ProjectRole } from "@/lib/enums";
import { requireUser, type SessionUser } from "@/server/auth";

export type ProjectAccess = {
  user: SessionUser;
  role: ProjectRole | null;
  isSuperAdmin: boolean;
  isOrgAdmin: boolean;
  permissions: Set<Permission>;
};

// Resolves the effective capabilities of the current user on a project.
// Policy = role defaults ∪ explicit overrides ∪ org/super admin escalation.
export async function getProjectAccess(projectId: string): Promise<ProjectAccess> {
  const user = await requireUser();

  const proj = await one<{ orgId: string }>(
    `SELECT org_id AS "orgId" FROM project WHERE id = $1`, [projectId]
  );

  const orgAdmin = proj
    ? await one(
        `SELECT m.id FROM org_membership m
         JOIN role r ON r.id = m.role_id
         WHERE m.org_id = $1 AND m.user_id = $2 AND r.key = 'org_admin'`,
        [proj.orgId, user.id]
      )
    : null;

  const pm = await one<{ role: ProjectRole; permissions: string }>(
    `SELECT role, permissions FROM project_member WHERE project_id = $1 AND user_id = $2`,
    [projectId, user.id]
  );

  const permissions = new Set<Permission>();
  if (pm?.role) ROLE_PERMISSIONS[pm.role]?.forEach((p) => permissions.add(p));
  if (pm?.permissions) {
    try { (JSON.parse(pm.permissions) as Permission[]).forEach((p) => permissions.add(p)); } catch {}
  }
  if (orgAdmin) {
    // Org admins oversee everything in THEIR organisation but, by policy, do NOT
    // create requisitions or generate reports — those are project-team work.
    // The platform super-admin is deliberately NOT escalated here: the operator
    // manages organisations, not the contents of tenant projects.
    ([
      "project.view", "project.comment", "project.edit", "project.administer",
      "members.manage", "budget.manage", "documents.manage",
      "requisitions.approve", "requisitions.sign", "approvals.approve",
    ] as Permission[]).forEach((p) => permissions.add(p));
  }

  // External collaborators get strictly read-only access, and ONLY to projects
  // they are explicitly linked to. Resolved via their login (collaborator.user_id)
  // → project_collaborator. Anyone not linked gets nothing here, so the project
  // layout's project.view check redirects them away.
  if (!permissions.has("project.view")) {
    const collabLink = await one(
      `SELECT 1 AS ok FROM project_collaborator pc
       JOIN collaborator c ON c.id = pc.collaborator_id
       WHERE pc.project_id = $1 AND c.user_id = $2`,
      [projectId, user.id]
    );
    if (collabLink) permissions.add("project.view");
  }

  // Staff assigned to a project in HR (employee_project, via their linked login)
  // get the same read-only, limited view as collaborators — so an employee the
  // PI/HR adds to a project can actually see it in their self-service portal.
  if (!permissions.has("project.view")) {
    const staffLink = await one(
      `SELECT 1 AS ok FROM employee_project ep
       JOIN employee e ON e.id = ep.employee_id
       WHERE ep.project_id = $1 AND e.user_id = $2`,
      [projectId, user.id]
    );
    if (staffLink) permissions.add("project.view");
  }

  return {
    user,
    role: pm?.role ?? null,
    isSuperAdmin: user.isSuperAdmin,
    isOrgAdmin: Boolean(orgAdmin),
    permissions,
  };
}

export async function can(projectId: string, permission: Permission): Promise<boolean> {
  const access = await getProjectAccess(projectId);
  return access.permissions.has(permission);
}

export async function requirePermission(projectId: string, permission: Permission): Promise<ProjectAccess> {
  const access = await getProjectAccess(projectId);
  if (!access.permissions.has(permission)) throw new Error("FORBIDDEN");
  return access;
}

// Clearing or importing a whole budget is a heavyweight, destructive operation,
// so it is reserved for the Principal Investigator, Co-PIs and Finance (plus org
// admins who oversee the organisation). Other budget.manage holders — e.g. a
// project manager — can still edit individual lines but not wipe or replace the
// whole budget.
const SENIOR_BUDGET_ROLES: ProjectRole[] = ["pi", "co_pi", "finance_admin"];
export function canManageBudgetBulk(access: ProjectAccess): boolean {
  return access.isOrgAdmin || (access.role != null && SENIOR_BUDGET_ROLES.includes(access.role));
}
export async function requireBudgetBulk(projectId: string): Promise<ProjectAccess> {
  const access = await getProjectAccess(projectId);
  if (!canManageBudgetBulk(access)) throw new Error("FORBIDDEN");
  return access;
}

// Only platform/org admins and Principal Investigators (including Co-PIs) may
// create projects. The admin seeds the first PI by creating a project and
// assigning them; PIs and Co-PIs can then spin up further projects.
export async function canCreateProjects(userId: string, isSuperAdmin: boolean): Promise<boolean> {
  if (isSuperAdmin) return true;
  const orgAdmin = await one(
    `SELECT m.id FROM org_membership m JOIN role r ON r.id = m.role_id
     WHERE m.user_id = $1 AND r.key = 'org_admin'`, [userId]
  );
  if (orgAdmin) return true;
  const pi = await one(`SELECT 1 AS ok FROM project_member WHERE user_id = $1 AND role IN ('pi','co_pi') LIMIT 1`, [userId]);
  return Boolean(pi);
}
