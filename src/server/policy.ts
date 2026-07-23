import "server-only";
import { q, one } from "@/server/db";
import { ROLE_PERMISSIONS, type Permission, type ProjectRole } from "@/lib/enums";
import { requireUser, type SessionUser } from "@/server/auth";

export type ProjectAccess = {
  user: SessionUser;
  role: ProjectRole | null;
  isSuperAdmin: boolean;
  isOrgAdmin: boolean;
  // True when the user is an ACTIVE employee of the project's organisation in an
  // institutional support department (Finance / Accounts / Administration / HR).
  // Such staff carry finance-admin capabilities on every project in their org.
  deptFinance: boolean;
  permissions: Set<Permission>;
};

// Departments whose staff service every project (finance, accounts,
// administration, human resources) — matched against the employee's free-text
// department AND the linked department record's name. Matching is against the
// WHOLE trimmed name, not substrings: "Research Administration", "Grants
// Administration" or "Accountability" must NOT confer finance authority.
const PRIVILEGED_DEPT =
  /^\s*(finance|finance\s*(&|and)\s*admin(istration)?|accounts?|accounting|accounts?\s*(&|and)\s*finance|admin(istration)?|human\s*resources?|hr)\s*$/i;

async function hasPrivilegedDepartment(orgId: string, userId: string): Promise<boolean> {
  const rows = await q<{ dept: string | null; deptName: string | null }>(
    `SELECT e.department AS dept, d.name AS "deptName"
     FROM employee e LEFT JOIN department d ON d.id = e.department_id
     WHERE e.user_id = $2 AND e.org_id = $1 AND e.status = 'active'`, [orgId, userId]);
  return rows.some((r) => PRIVILEGED_DEPT.test(r.dept ?? "") || PRIVILEGED_DEPT.test(r.deptName ?? ""));
}

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

  // Institutional support staff — active employees in the Finance / Accounts /
  // Administration / HR departments — service every project in their
  // organisation, so they carry the finance-admin capability set on all of the
  // org's projects without needing per-project membership. An EXPLICIT project
  // membership always wins: if the team deliberately gave such a person a
  // narrower role (e.g. viewer) on a project, the department grant does not
  // apply there — permissions are additive and this is the only way to
  // restrict a support-department employee on a specific project.
  let deptFinance = false;
  if (proj && !orgAdmin && !pm) {
    deptFinance = await hasPrivilegedDepartment(proj.orgId, user.id);
    if (deptFinance) ROLE_PERMISSIONS.finance_admin.forEach((p) => permissions.add(p));
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
    // Support-department staff without an explicit membership act as the
    // project's finance admin (role-gated helpers like refund approval and
    // bulk budget rights treat them accordingly).
    role: pm?.role ?? (deptFinance ? "finance_admin" : null),
    isSuperAdmin: user.isSuperAdmin,
    isOrgAdmin: Boolean(orgAdmin),
    deptFinance,
    permissions,
  };
}

export async function can(projectId: string, permission: Permission): Promise<boolean> {
  const access = await getProjectAccess(projectId);
  return access.permissions.has(permission);
}

// File-serving routes must match the page-tier model: restricted logins —
// staff self-service accounts (without support-department rights) and external
// collaborators — are blocked from finance/requisition documents even though
// they hold project.view for the limited tabs.
export async function canViewProjectFiles(projectId: string): Promise<boolean> {
  const access = await getProjectAccess(projectId);
  const restricted = (access.user.isStaff && !access.deptFinance) || access.user.isCollaborator;
  return access.permissions.has("project.view") && !restricted;
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

// Which people may decide a given requisition approval step. STRICT role
// separation: the PM/PI step is signable ONLY by the PI / Co-PI / project
// manager, and the finance step ONLY by the finance admin (incl.
// support-department staff, who surface as role 'finance_admin') — being an
// organisation admin does NOT allow signing on another role's behalf. Only a
// configured 'admin' step belongs to org admins / designated approvers.
export function canDecideStep(access: ProjectAccess, stepRole: string): boolean {
  if (stepRole === "finance_admin") return access.role === "finance_admin";
  if (stepRole === "pm") return access.role === "pi" || access.role === "co_pi" || access.role === "project_manager";
  if (stepRole === "admin") return access.isOrgAdmin || access.role === "approver";
  return false;
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
