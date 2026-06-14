import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { addMemberAction, updateMemberRoleAction, removeMemberAction,
  upsertEmployeeProjectAction, removeEmployeeProjectAction,
  updateCollaboratorProjectRoleAction, removeCollaboratorProjectLinkAction } from "@/app/actions";
import { SectionTitle, Badge, Field } from "@/components/ui";
import { PROJECT_ROLES, ROLE_PERMISSIONS, label } from "@/lib/enums";
import { blockStaff } from "../_staffblock";

const COLLAB_ROLES = [["co_investigator", "Co-Investigator"], ["partner", "Partner"], ["funder", "Funder"], ["advisor", "Advisor"], ["sub_grantee", "Sub-grantee"], ["collaborator", "Collaborator"]];

export default async function TeamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ invite?: string; why?: string; saved?: string }> }) {
  const { id } = await params;
  await blockStaff(id);
  const sp = await searchParams;
  const access = await getProjectAccess(id);
  const canManage = access.permissions.has("members.manage");

  const members = await q<{ userId: string; name: string; email: string; role: string; status: string; title: string | null }>(
    `SELECT pm.user_id AS "userId", u.name, u.email, pm.role, u.status, up.title
     FROM project_member pm
     JOIN app_user u ON u.id = pm.user_id
     LEFT JOIN user_profile up ON up.user_id = u.id
     WHERE pm.project_id=$1 ORDER BY pm.created_at`, [id]
  );

  // Staff assigned to this project (HR view of who works on it), and the org's
  // employees available to assign. Plus external collaborators linked here.
  const proj = await one<{ orgId: string }>(`SELECT org_id AS "orgId" FROM project WHERE id=$1`, [id]);
  const orgId = proj?.orgId ?? null;
  const staff = await q<{ id: string; employeeId: string; name: string; role: string | null; responsibilities: string | null }>(
    `SELECT ep.id, ep.employee_id AS "employeeId",
            (CASE WHEN e.prefix IS NOT NULL AND e.prefix<>'' THEN e.prefix||' ' ELSE '' END)||e.first_name||' '||e.last_name AS name,
            ep.role, ep.responsibilities
     FROM employee_project ep JOIN employee e ON e.id=ep.employee_id
     WHERE ep.project_id=$1 ORDER BY e.last_name, e.first_name`, [id]
  );
  const assignedEmpIds = new Set(staff.map((s) => s.employeeId));
  const orgEmployees = orgId ? await q<{ id: string; name: string }>(
    `SELECT id, (CASE WHEN prefix IS NOT NULL AND prefix<>'' THEN prefix||' ' ELSE '' END)||first_name||' '||last_name AS name
     FROM employee WHERE org_id=$1 AND status<>'terminated' ORDER BY last_name, first_name`, [orgId]
  ) : [];
  const assignableEmployees = orgEmployees.filter((e) => !assignedEmpIds.has(e.id));
  const collaborators = await q<{ id: string; name: string; role: string; responsibilities: string | null }>(
    `SELECT pc.id, (CASE WHEN c.prefix IS NOT NULL AND c.prefix<>'' THEN c.prefix||' ' ELSE '' END)||c.name AS name, pc.role, pc.responsibilities
     FROM project_collaborator pc JOIN collaborator c ON c.id=pc.collaborator_id
     WHERE pc.project_id=$1 ORDER BY c.name`, [id]
  );

  return (
    <div className="space-y-7">
      <div>
        <SectionTitle>Team members</SectionTitle>
        {sp.invite === "sent" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Invitation email sent.</div>}
        {sp.invite === "added" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Member added to the project (they already had an account, so no invite email was needed).</div>}
        {sp.invite === "emailfailed" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Member was added, but the invitation email failed to send{sp.why ? `: ${sp.why}` : ""}. Fix email in Admin → Email delivery, then ask them to use “Forgot password” with this email to get their link.</div>}
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Name</th>
              <th className="th text-left">Email</th>
              <th className="th text-left">Role</th>
              <th className="th text-left">Capabilities</th>
              <th className="th text-left">Status</th>
              {canManage && <th className="th text-left">Actions</th>}
            </tr></thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.userId}>
                  <td className="td">
                    <div className="font-medium">{m.name}</div>
                    {m.title && <div className="text-xs" style={{ color: "var(--muted)" }}>{m.title}</div>}
                  </td>
                  <td className="td">{m.email}</td>
                  <td className="td">
                    {canManage ? (
                      <form action={updateMemberRoleAction} className="flex items-center gap-2">
                        <input type="hidden" name="projectId" value={id} />
                        <input type="hidden" name="userId" value={m.userId} />
                        <select name="role" defaultValue={m.role} className="select" style={{ width: 150, padding: "4px 8px" }}>
                          {PROJECT_ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}
                        </select>
                        <button className="btn btn-sm" type="submit">Set</button>
                      </form>
                    ) : <Badge tone="brand">{label(m.role)}</Badge>}
                  </td>
                  <td className="td text-xs" style={{ color: "var(--muted)" }}>
                    {(ROLE_PERMISSIONS[m.role as keyof typeof ROLE_PERMISSIONS] ?? []).length} permissions
                  </td>
                  <td className="td">{m.status === "invited" ? <Badge tone="warn">invited</Badge> : <Badge tone="ok">active</Badge>}</td>
                  {canManage && (
                    <td className="td">
                      {m.userId === access.user.id ? (
                        <span className="text-xs" style={{ color: "var(--muted)" }}>You</span>
                      ) : (
                        <form action={removeMemberAction}>
                          <input type="hidden" name="projectId" value={id} />
                          <input type="hidden" name="userId" value={m.userId} />
                          <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Revoke</button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Staff assigned to this project (HR/PI view of who works on it) */}
      <div>
        <SectionTitle>Staff on this project</SectionTitle>
        {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
        {staff.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>No staff assigned yet.{canManage ? " Assign employees and their responsibilities below." : ""}</p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Employee</th><th className="th text-left" style={{ minWidth: 360 }}>Role &amp; responsibilities</th>{canManage && <th className="th" />}</tr></thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.id}>
                    <td className="td font-medium">{s.name}</td>
                    <td className="td">
                      {canManage ? (
                        <form action={upsertEmployeeProjectAction} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="projectId" value={id} />
                          <input type="hidden" name="employeeId" value={s.employeeId} />
                          <input type="hidden" name="back" value={`/projects/${id}/team`} />
                          <input name="role" defaultValue={s.role ?? ""} className="input" placeholder="Role" style={{ width: 150 }} />
                          <input name="responsibilities" defaultValue={s.responsibilities ?? ""} className="input" placeholder="Responsibilities" style={{ minWidth: 200, flex: 1 }} />
                          <button className="btn btn-sm" type="submit">Save</button>
                        </form>
                      ) : (
                        <span>{s.role ? <Badge tone="brand">{label(s.role)}</Badge> : null} <span style={{ color: "var(--muted)" }}>{s.responsibilities ?? ""}</span></span>
                      )}
                    </td>
                    {canManage && (
                      <td className="td text-right">
                        <form action={removeEmployeeProjectAction}>
                          <input type="hidden" name="projectId" value={id} />
                          <input type="hidden" name="employeeId" value={s.employeeId} />
                          <input type="hidden" name="back" value={`/projects/${id}/team`} />
                          <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Remove</button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canManage && assignableEmployees.length > 0 && (
          <form action={upsertEmployeeProjectAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-end mt-3">
            <input type="hidden" name="projectId" value={id} />
            <input type="hidden" name="back" value={`/projects/${id}/team`} />
            <Field label="Employee"><select name="employeeId" required className="select"><option value="">— choose —</option>{assignableEmployees.map((emp) => <option key={emp.id} value={emp.id}>{emp.name}</option>)}</select></Field>
            <Field label="Role"><input name="role" className="input" placeholder="e.g. Field Coordinator" /></Field>
            <Field label="Responsibilities"><input name="responsibilities" className="input" /></Field>
            <button className="btn btn-primary" type="submit">Assign staff</button>
          </form>
        )}
        {canManage && orgEmployees.length === 0 && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>No employees in HR yet — add staff under HR → Employees first.</p>}
      </div>

      {/* External collaborators linked to this project */}
      <div>
        <SectionTitle>Collaborators</SectionTitle>
        {collaborators.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>No external collaborators linked.{canManage ? " Link them from the Collaborations section, then set their role here." : ""}</p>
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Collaborator</th><th className="th text-left" style={{ minWidth: 360 }}>Role &amp; responsibilities</th>{canManage && <th className="th" />}</tr></thead>
              <tbody>
                {collaborators.map((cl) => (
                  <tr key={cl.id}>
                    <td className="td font-medium">{cl.name}</td>
                    <td className="td">
                      {canManage ? (
                        <form action={updateCollaboratorProjectRoleAction} className="flex flex-wrap items-end gap-2">
                          <input type="hidden" name="projectId" value={id} />
                          <input type="hidden" name="linkId" value={cl.id} />
                          <input type="hidden" name="back" value={`/projects/${id}/team`} />
                          <select name="role" defaultValue={cl.role} className="select" style={{ width: 150 }}>{COLLAB_ROLES.map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}</select>
                          <input name="responsibilities" defaultValue={cl.responsibilities ?? ""} className="input" placeholder="Responsibilities" style={{ minWidth: 200, flex: 1 }} />
                          <button className="btn btn-sm" type="submit">Save</button>
                        </form>
                      ) : (
                        <span><Badge tone="info">{label(cl.role)}</Badge> <span style={{ color: "var(--muted)" }}>{cl.responsibilities ?? ""}</span></span>
                      )}
                    </td>
                    {canManage && (
                      <td className="td text-right">
                        <form action={removeCollaboratorProjectLinkAction}>
                          <input type="hidden" name="projectId" value={id} />
                          <input type="hidden" name="linkId" value={cl.id} />
                          <input type="hidden" name="back" value={`/projects/${id}/team`} />
                          <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Remove</button>
                        </form>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canManage && (
        <div>
          <SectionTitle>Invite a member</SectionTitle>
          <form action={addMemberAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-end">
            <input type="hidden" name="projectId" value={id} />
            <Field label="Email"><input type="email" name="email" required className="input" placeholder="person@example.org" /></Field>
            <Field label="Name (optional)"><input name="name" className="input" placeholder="Jane Doe" /></Field>
            <Field label="Role">
              <select name="role" className="select" defaultValue="member">
                {PROJECT_ROLES.map((r) => <option key={r} value={r}>{label(r)}</option>)}
              </select>
            </Field>
            <button className="btn btn-primary" type="submit">Send invite</button>
          </form>
          <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
            New emails get an invited account and a notification. Roles map to capability sets — PI/PM have full control,
            finance manages money, coordinators run activities and raise requisitions, viewers are read-only.
          </p>
        </div>
      )}
    </div>
  );
}
