import { getProjectAccess } from "@/server/policy";
import { q } from "@/server/db";
import { addMemberAction, updateMemberRoleAction, removeMemberAction } from "@/app/actions";
import { SectionTitle, Badge, Field } from "@/components/ui";
import { PROJECT_ROLES, ROLE_PERMISSIONS, label } from "@/lib/enums";

export default async function TeamPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ invite?: string; why?: string }> }) {
  const { id } = await params;
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
