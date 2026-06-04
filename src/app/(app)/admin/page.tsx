import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/server/auth";
import { q } from "@/server/db";
import { PageHeader, Stat, SectionTitle, Badge, StatusBadge, severityTone, Field } from "@/components/ui";
import { createAdminAction, createOrganizationAction, setOrgStateAction } from "@/app/actions";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ created?: string; error?: string }> }) {
  const user = await requireUser();
  if (!user.isSuperAdmin) redirect("/dashboard");
  const { created, error } = await searchParams;

  const orgs = await q<{ id: string; name: string; plan: string; status: string; trialEndsAt: string | null; adminEmail: string | null; members: number; projects: number }>(
    `SELECT o.id, o.name, o.plan, o.status, o.trial_ends_at AS "trialEndsAt",
            (SELECT u.email FROM org_membership m JOIN app_user u ON u.id=m.user_id JOIN role r ON r.id=m.role_id
             WHERE m.org_id=o.id AND r.key='org_admin' ORDER BY m.created_at LIMIT 1) AS "adminEmail",
            (SELECT COUNT(*)::int FROM org_membership m WHERE m.org_id=o.id) AS members,
            (SELECT COUNT(*)::int FROM project p WHERE p.org_id=o.id) AS projects
     FROM organization o ORDER BY o.created_at DESC`
  );

  const counts = await q<{ orgs: number; projects: number; users: number; flags: number }>(
    `SELECT (SELECT COUNT(*)::int FROM organization) AS orgs,
            (SELECT COUNT(*)::int FROM project) AS projects,
            (SELECT COUNT(*)::int FROM app_user) AS users,
            (SELECT COUNT(*)::int FROM anomaly_flag WHERE resolved=false) AS flags`
  );
  const c = counts[0];

  const projects = await q<{ id: string; code: string; title: string; status: string; org: string; flags: number }>(
    `SELECT p.id, p.code, p.title, p.status, o.name AS org,
            (SELECT COUNT(*)::int FROM anomaly_flag WHERE project_id=p.id AND resolved=false) AS flags
     FROM project p JOIN organization o ON o.id=p.org_id ORDER BY p.created_at DESC`
  );
  const users = await q<{ id: string; name: string; email: string; status: string; isSuper: boolean }>(
    `SELECT id, name, email, status, is_super_admin AS "isSuper" FROM app_user ORDER BY created_at`
  );
  const flags = await q<{ id: string; rule: string; severity: string; message: string; projectId: string; code: string }>(
    `SELECT f.id, f.rule, f.severity, f.message, f.project_id AS "projectId", p.code
     FROM anomaly_flag f JOIN project p ON p.id=f.project_id
     WHERE f.resolved=false ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END LIMIT 12`
  );
  const audit = await q<{ id: string; action: string; entity: string; createdAt: string; actor: string | null }>(
    `SELECT a.id, a.action, a.entity, a.created_at AS "createdAt", u.name AS actor
     FROM audit_log a LEFT JOIN app_user u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 15`
  );

  return (
    <div className="space-y-7">
      <PageHeader title="Admin control center" subtitle="Organisation-wide oversight across projects, people, finance and activity." />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Organisations" value={c.orgs} />
        <Stat label="Projects" value={c.projects} />
        <Stat label="Users" value={c.users} />
        <Stat label="Open flags" value={c.flags} tone={c.flags ? "danger" : "ok"} />
      </div>

      {/* ---------------- Organisations (tenants) ---------------- */}
      <div>
        <SectionTitle>Organisations</SectionTitle>
        {created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Organisation created — the admin was emailed their username and temporary password.</div>}
        {error && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{error}</div>}

        <form action={createOrganizationAction} className="card p-4 mb-3 grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
          <Field label="Organisation name"><input name="orgName" required className="input" placeholder="African Center for Health Research" /></Field>
          <Field label="Admin name"><input name="adminName" className="input" placeholder="Full name" /></Field>
          <Field label="Admin email"><input type="email" name="adminEmail" required className="input" placeholder="admin@org.org" /></Field>
          <div className="flex items-end gap-2">
            <Field label="Trial (days)"><input type="number" name="trialDays" defaultValue={90} className="input" style={{ width: 90 }} /></Field>
            <button className="btn btn-primary" type="submit">Create</button>
          </div>
          <p className="sm:col-span-2 lg:col-span-4 text-xs" style={{ color: "var(--muted)" }}>
            Creates the workspace + its admin account and emails them their username and temporary password. Each organisation only ever sees its own projects.
          </p>
        </form>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Organisation</th><th className="th text-left">Admin</th>
              <th className="th text-left">Plan</th><th className="th text-center">Projects</th>
              <th className="th text-left">Actions</th>
            </tr></thead>
            <tbody>
              {orgs.map((o) => {
                const ended = o.plan === "trial" && o.trialEndsAt && new Date(o.trialEndsAt) < new Date();
                const tone = o.status === "suspended" ? "danger" : o.plan === "active" ? "ok" : ended ? "danger" : "warn";
                const planLabel = o.status === "suspended" ? "Suspended" : o.plan === "active" ? "Paid · active" : ended ? "Trial ended" : `Trial · ends ${fmtDate(o.trialEndsAt)}`;
                return (
                  <tr key={o.id} className="hover:bg-[var(--surface)]">
                    <td className="td"><div className="font-medium">{o.name}</div><div className="text-xs" style={{ color: "var(--muted)" }}>{o.members} member{o.members === 1 ? "" : "s"}</div></td>
                    <td className="td text-xs">{o.adminEmail ?? "—"}</td>
                    <td className="td"><Badge tone={tone}>{planLabel}</Badge></td>
                    <td className="td text-center">{o.projects}</td>
                    <td className="td">
                      <div className="flex flex-wrap gap-1.5">
                        <form action={setOrgStateAction}><input type="hidden" name="orgId" value={o.id} /><input type="hidden" name="action" value="activate" /><button className="btn btn-sm" type="submit">Activate</button></form>
                        <form action={setOrgStateAction}><input type="hidden" name="orgId" value={o.id} /><input type="hidden" name="action" value="extend" /><input type="hidden" name="days" value="90" /><button className="btn btn-sm" type="submit">+90d trial</button></form>
                        <form action={setOrgStateAction}><input type="hidden" name="orgId" value={o.id} /><input type="hidden" name="action" value={o.status === "suspended" ? "activate" : "suspend"} /><button className="btn btn-sm" type="submit">{o.status === "suspended" ? "Unsuspend" : "Suspend"}</button></form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div>
          <SectionTitle>All projects</SectionTitle>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Project</th><th className="th text-left">Org</th><th className="th text-left">Status</th><th className="th text-center">Flags</th></tr></thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.id} className="hover:bg-[var(--surface)]">
                    <td className="td"><Link href={`/projects/${p.id}`} className="hover:underline"><span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{p.code}</span> {p.title}</Link></td>
                    <td className="td text-xs">{p.org}</td>
                    <td className="td"><StatusBadge status={p.status} /></td>
                    <td className="td text-center">{p.flags ? <Badge tone="danger">{p.flags}</Badge> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <SectionTitle>Financial exceptions</SectionTitle>
          <div className="card p-4">
            {flags.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>No outstanding anomalies.</p> : (
              <div className="space-y-2">
                {flags.map((f) => (
                  <Link key={f.id} href={`/projects/${f.projectId}`} className="flex items-start gap-2 py-1.5 border-b last:border-0 hover:underline" style={{ borderColor: "var(--border)" }}>
                    <Badge tone={severityTone(f.severity)}>{label(f.rule)}</Badge>
                    <span className="text-sm min-w-0"><span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{f.code}</span> {f.message}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <div>
          <SectionTitle>Users</SectionTitle>
          <form action={createAdminAction} className="card p-4 mb-3 flex flex-wrap items-end gap-3">
            <Field label="New admin email"><input type="email" name="email" required className="input" placeholder="admin@org.org" /></Field>
            <Field label="Name"><input name="name" className="input" placeholder="Full name" /></Field>
            <button className="btn btn-primary" type="submit">Create admin account</button>
            <span className="text-xs" style={{ color: "var(--muted)" }}>They receive an email link to set their password.</span>
          </form>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Name</th><th className="th text-left">Email</th><th className="th text-left">Status</th></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td className="td">{u.name} {u.isSuper && <Badge tone="brand">admin</Badge>}</td>
                    <td className="td">{u.email}</td>
                    <td className="td">{u.status === "invited" ? <Badge tone="warn">invited</Badge> : <Badge tone="ok">active</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <SectionTitle>System audit log</SectionTitle>
          <div className="card p-4">
            <div className="space-y-2">
              {audit.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 text-sm py-1 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
                  <span><Badge tone="muted">{a.action}</Badge> {label(a.entity)}</span>
                  <span className="text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>{a.actor ?? "system"} · {fmtDateTime(a.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
