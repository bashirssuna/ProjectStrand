import Link from "next/link";
import { requireHrOrg } from "../../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { PROJECT_ROLES, label } from "@/lib/enums";
import { bulkSetDepartmentAccessAction } from "@/app/actions";

type Person = { id: string; email: string; name: string; status: string; isStaff: boolean; isCollaborator: boolean; department: string | null; jobTitle: string | null; isOrgAdmin: boolean };

export default async function AccessManagePage({ searchParams }: { searchParams: Promise<{ saved?: string; err?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const sp = await searchParams;

  const people = await q<Person>(
    `SELECT u.id, u.email, u.name, u.status, COALESCE(u.is_staff,false) AS "isStaff", COALESCE(u.is_collaborator,false) AS "isCollaborator",
            (SELECT department FROM employee WHERE user_id=u.id AND org_id=$1 LIMIT 1) AS department,
            (SELECT job_title FROM employee WHERE user_id=u.id AND org_id=$1 LIMIT 1) AS "jobTitle",
            EXISTS(SELECT 1 FROM org_membership m2 JOIN role r ON r.id=m2.role_id WHERE m2.org_id=$1 AND m2.user_id=u.id AND r.key='org_admin') AS "isOrgAdmin"
     FROM org_membership m JOIN app_user u ON u.id=m.user_id
     WHERE m.org_id=$1 ORDER BY u.name`, [orgId]
  );
  const roles = await q<{ userId: string; projectCode: string; role: string }>(
    `SELECT pm.user_id AS "userId", p.code AS "projectCode", pm.role
     FROM project_member pm JOIN project p ON p.id=pm.project_id WHERE p.org_id=$1 ORDER BY p.code`, [orgId]
  );
  const rolesByUser = new Map<string, { projectCode: string; role: string }[]>();
  for (const r of roles) { if (!rolesByUser.has(r.userId)) rolesByUser.set(r.userId, []); rolesByUser.get(r.userId)!.push(r); }

  const departments = await q<{ department: string }>(
    `SELECT DISTINCT department FROM employee WHERE org_id=$1 AND department IS NOT NULL AND department<>'' ORDER BY department`, [orgId]
  );
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);

  // group people by department
  const groups = new Map<string, Person[]>();
  for (const p of people) {
    const key = p.department && p.department.trim() ? p.department : "Unassigned / external";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }
  const orderedDepts = [...groups.keys()].sort((a, b) => a === "Unassigned / external" ? 1 : b === "Unassigned / external" ? -1 : a.localeCompare(b));

  return (
    <div className="max-w-5xl">
      <PageHeader title="Access management" subtitle={`Who can see and do what · ${orgName}`} actions={<Link href="/hr/access" className="btn btn-sm">Role reference →</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Updated access for {sp.saved} {Number(sp.saved) === 1 ? "person" : "people"}.</div>}
      {sp.err === "fields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Choose a department and a project.</div>}
      {sp.err === "proj" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>That project doesn&apos;t belong to your organisation.</div>}

      <p className="text-sm mb-5" style={{ color: "var(--muted)" }}>
        This lists everyone in {orgName} and the access they currently hold. Open a person to change their role and fine-grained permissions on any
        project, or use the bulk tool to grant a whole department a role on a project at once.
      </p>

      {/* Department bulk assign */}
      <SectionTitle>Grant a department access to a project</SectionTitle>
      {departments.length === 0 || projects.length === 0 ? (
        <div className="card p-4 mb-6 text-sm" style={{ color: "var(--muted)" }}>
          {departments.length === 0 ? "Add departments and assign staff to them (HR → Departments) " : "Create a project "}
          to use bulk department assignment.
        </div>
      ) : (
        <form action={bulkSetDepartmentAccessAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-end mb-6">
          <Field label="Department"><select name="department" required className="select">{departments.map((d) => <option key={d.department} value={d.department}>{d.department}</option>)}</select></Field>
          <Field label="Project"><select name="projectId" required className="select">{projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></Field>
          <Field label="Role"><select name="role" className="select">{PROJECT_ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}<option value="none">Remove access</option></select></Field>
          <div className="flex justify-end"><button className="btn btn-primary" type="submit">Apply to department</button></div>
          <p className="sm:col-span-4 text-xs" style={{ color: "var(--muted)" }}>Applies to every employee in the department who has a login. Existing fine-grained permissions are preserved when only the role changes.</p>
        </form>
      )}

      {/* People directory grouped by department */}
      <SectionTitle>People &amp; their access</SectionTitle>
      {people.length === 0 ? <Empty title="No users yet" hint="Invite staff (HR) or add project members to populate this list." /> : (
        <div className="space-y-5">
          {orderedDepts.map((dept) => (
            <div key={dept}>
              <div className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>{dept} · {groups.get(dept)!.length}</div>
              <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
                {groups.get(dept)!.map((p) => {
                  const pr = rolesByUser.get(p.id) ?? [];
                  return (
                    <div key={p.id} className="flex items-start justify-between gap-3 p-3" style={{ borderColor: "var(--border)" }}>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{p.name}</span>
                          {p.isOrgAdmin && <Badge tone="brand">Org admin</Badge>}
                          {p.isCollaborator && <Badge tone="info">Collaborator</Badge>}
                          {p.isStaff && !p.isOrgAdmin && <Badge tone="muted">Staff</Badge>}
                          {p.status === "invited" && <Badge tone="warn">invited</Badge>}
                        </div>
                        <div className="text-xs" style={{ color: "var(--muted)" }}>{p.email}{p.jobTitle ? ` · ${p.jobTitle}` : ""}</div>
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {pr.length === 0 ? <span className="text-xs" style={{ color: "var(--muted)" }}>No project access</span>
                            : pr.map((r) => <Badge key={r.projectCode} tone="ok">{r.projectCode}: {label(r.role)}</Badge>)}
                        </div>
                      </div>
                      <Link href={`/hr/access/manage/${p.id}`} className="btn btn-sm shrink-0">Manage</Link>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
