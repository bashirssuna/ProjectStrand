import { redirect } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/server/auth";
import { q } from "@/server/db";
import { PageHeader, Stat, SectionTitle, Badge, StatusBadge, severityTone, Field } from "@/components/ui";
import { createAdminAction } from "@/app/actions";
import { money, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";

export default async function AdminPage() {
  const user = await requireUser();
  if (!user.isSuperAdmin) redirect("/dashboard");

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
