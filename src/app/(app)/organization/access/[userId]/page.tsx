import Link from "next/link";
import { notFound } from "next/navigation";
import { requireOrgAdmin } from "../../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Badge } from "@/components/ui";
import { PROJECT_ROLES, PERMISSIONS, ROLE_PERMISSIONS, type Permission, type ProjectRole, label } from "@/lib/enums";
import { saveUserProjectAccessAction, setOrgAdminAction } from "@/app/actions";

const PERM_LABEL: Record<Permission, string> = {
  "project.view": "View", "project.comment": "Comment", "project.edit": "Edit content",
  "project.administer": "Administer", "members.manage": "Manage team", "budget.manage": "Manage budget",
  "documents.manage": "Manage documents", "reports.manage": "Manage reports", "requisitions.create": "Raise requisitions",
  "requisitions.approve": "Approve requisitions", "requisitions.sign": "Sign requisitions", "approvals.approve": "Approve items",
};

export default async function PersonAccessPage({ params, searchParams }: { params: Promise<{ userId: string }>; searchParams: Promise<{ saved?: string; err?: string }> }) {
  const { userId } = await params;
  const { orgId, userId: meId } = await requireOrgAdmin();
  const sp = await searchParams;

  const person = await one<{ id: string; email: string; name: string; status: string; isStaff: boolean; isCollaborator: boolean; department: string | null; jobTitle: string | null; isOrgAdmin: boolean }>(
    `SELECT u.id, u.email, u.name, u.status, COALESCE(u.is_staff,false) AS "isStaff", COALESCE(u.is_collaborator,false) AS "isCollaborator",
            (SELECT department FROM employee WHERE user_id=u.id AND org_id=$2 LIMIT 1) AS department,
            (SELECT job_title FROM employee WHERE user_id=u.id AND org_id=$2 LIMIT 1) AS "jobTitle",
            EXISTS(SELECT 1 FROM org_membership m2 JOIN role r ON r.id=m2.role_id WHERE m2.org_id=$2 AND m2.user_id=u.id AND r.key='org_admin') AS "isOrgAdmin"
     FROM app_user u JOIN org_membership m ON m.user_id=u.id AND m.org_id=$2 WHERE u.id=$1`, [userId, orgId]
  );
  if (!person) notFound();

  const projects = await q<{ id: string; code: string; title: string; role: string | null; permissions: string | null }>(
    `SELECT p.id, p.code, p.title, pm.role, pm.permissions
     FROM project p LEFT JOIN project_member pm ON pm.project_id=p.id AND pm.user_id=$1
     WHERE p.org_id=$2 ORDER BY p.created_at DESC`, [userId, orgId]
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title={person.name} subtitle="Access & permissions" actions={<Link href="/organization/access" className="btn btn-sm">← All people</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Access saved.</div>}
      {sp.err === "self" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>You can&apos;t change your own organisation-admin status — ask another admin.</div>}
      {sp.err === "lastadmin" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>You can&apos;t remove the last organisation administrator.</div>}
      {sp.err === "role" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Invalid role.</div>}

      {/* Identity + org admin */}
      <div className="card p-4 mb-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              {person.isOrgAdmin && <Badge tone="brand">Org admin</Badge>}
              {person.isCollaborator && <Badge tone="info">Collaborator</Badge>}
              {person.isStaff && <Badge tone="muted">Staff</Badge>}
              {person.status === "invited" && <Badge tone="warn">invited</Badge>}
            </div>
            <div className="text-sm mt-1">{person.email}</div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>{[person.jobTitle, person.department].filter(Boolean).join(" · ") || "No HR record"}</div>
          </div>
          {person.id !== meId && (
            person.isOrgAdmin ? (
              <form action={setOrgAdminAction}><input type="hidden" name="userId" value={person.id} /><input type="hidden" name="makeAdmin" value="0" /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Revoke org admin</button></form>
            ) : (
              <form action={setOrgAdminAction}><input type="hidden" name="userId" value={person.id} /><input type="hidden" name="makeAdmin" value="1" /><button className="btn btn-sm" type="submit">Make org admin</button></form>
            )
          )}
        </div>
        {person.isOrgAdmin && <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>Organisation admins have full access to every module (Finance, HR, Procurement, all projects) and to access management. Project roles below don&apos;t restrict an org admin.</p>}
      </div>

      {/* Per-project access */}
      <SectionTitle>Project access</SectionTitle>
      <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
        Set a role per project. The role grants a baseline set of permissions; tick extra permissions to grant them on top. Permissions the role already
        includes are shown as &quot;via role&quot; and need a role change to remove.
      </p>
      <div className="space-y-3">
        {projects.map((p) => {
          let extras: string[] = [];
          if (p.permissions) { try { extras = JSON.parse(p.permissions) as string[]; } catch {} }
          const extrasSet = new Set(extras);
          const currentRole = (p.role ?? "none") as ProjectRole | "none";
          const roleGrants = currentRole !== "none" ? new Set<Permission>(ROLE_PERMISSIONS[currentRole]) : new Set<Permission>();
          const grantable = PERMISSIONS.filter((perm) => !roleGrants.has(perm));
          return (
            <form action={saveUserProjectAccessAction} key={p.id} className="card p-4">
              <input type="hidden" name="userId" value={person.id} />
              <input type="hidden" name="projectId" value={p.id} />
              <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
                <div>
                  <span className="font-mono text-xs" style={{ color: "var(--brand)" }}>{p.code}</span>
                  <span className="ml-2 text-sm">{p.title}</span>
                </div>
                <div className="flex items-center gap-2">
                  <select name="role" defaultValue={currentRole} className="select" style={{ width: 180 }}>
                    <option value="none">No access</option>
                    {PROJECT_ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                  </select>
                  <button className="btn btn-sm btn-primary" type="submit">Save</button>
                </div>
              </div>
              {currentRole !== "none" && (
                <div className="border-t pt-3 mt-1" style={{ borderColor: "var(--border)" }}>
                  {roleGrants.size > 0 && (
                    <div className="flex flex-wrap gap-1 mb-2">
                      {PERMISSIONS.filter((perm) => roleGrants.has(perm)).map((perm) => (
                        <Badge key={perm} tone="muted">{PERM_LABEL[perm]} · via role</Badge>
                      ))}
                    </div>
                  )}
                  <div className="grid sm:grid-cols-3 gap-x-4 gap-y-1.5">
                    {grantable.map((perm) => (
                      <label key={perm} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name="perms" value={perm} defaultChecked={extrasSet.has(perm)} /> {PERM_LABEL[perm]}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </form>
          );
        })}
        {projects.length === 0 && <div className="card p-4 text-sm" style={{ color: "var(--muted)" }}>This organisation has no projects yet.</div>}
      </div>
    </div>
  );
}
