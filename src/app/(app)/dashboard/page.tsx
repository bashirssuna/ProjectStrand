import Link from "next/link";
import { requireUser } from "@/server/auth";
import { listProjectsForUser, getProjectSummary, healthScore } from "@/server/services/projects";
import { q } from "@/server/db";
import { getUserOrg } from "@/server/services/accounts";
import { PageHeader, Stat, Badge, StatusBadge, ProgressBar, Empty } from "@/components/ui";
import { money, pct, fmtDateTime, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

export default async function DashboardPage() {
  const user = await requireUser();
  const org = user.isSuperAdmin ? null : await getUserOrg(user.id);
  const trialDaysLeft = org?.plan === "trial" && org.trialEndsAt
    ? Math.ceil((new Date(org.trialEndsAt).getTime() - Date.now()) / 86400000) : null;
  const projects = await listProjectsForUser(user.id, user.isSuperAdmin);
  const summaries = await Promise.all(projects.map((p) => getProjectSummary(p.id)));

  const totalPlanned = summaries.reduce((s, x) => s + (x?.budget?.planned ?? 0), 0);
  const totalSpent = summaries.reduce((s, x) => s + (x?.budget?.actual ?? 0), 0);
  const totalFlags = summaries.reduce((s, x) => s + (x?.counts.openFlags ?? 0), 0);

  const notifications = await q<{ id: string; type: string; title: string; body: string | null; link: string | null; createdAt: string; read: boolean }>(
    `SELECT id, type, title, body, link, created_at AS "createdAt", read FROM notification
     WHERE user_id=$1 ORDER BY created_at DESC LIMIT 8`, [user.id]
  );

  const pendingSignatures = await q<{ id: string; number: string; title: string; projectId: string; amount: number }>(
    `SELECT r.id, r.number, r.title, r.project_id AS "projectId", r.amount
     FROM requisition r
     JOIN requisition_approval ra ON ra.requisition_id=r.id AND ra.decision='pending'
     JOIN project_member pm ON pm.project_id=r.project_id AND pm.user_id=$1
     WHERE (ra.role='pm' AND pm.role IN ('project_manager','pi'))
        OR (ra.role='finance_admin' AND pm.role='finance_admin')
        OR (ra.role='admin' AND pm.role='pi')
     GROUP BY r.id, r.number, r.title, r.project_id, r.amount`, [user.id]
  );

  const meetings = await q<{ id: string; title: string; startsAt: string; projectId: string; url: string | null }>(
    `SELECT m.id, m.title, m.starts_at AS "startsAt", m.project_id AS "projectId", m.meeting_url AS url
     FROM meeting m JOIN project_member pm ON pm.project_id=m.project_id AND pm.user_id=$1
     WHERE m.starts_at > now() ORDER BY m.starts_at LIMIT 5`, [user.id]
  );

  return (
    <div>
      <PageHeader
        title={`Welcome back, ${user.name.split(" ")[0]}`}
        subtitle="Your portfolio at a glance — schedule, spend, and anything that needs a signature."
        actions={<Link href="/projects/new" className="btn btn-primary">+ New project</Link>}
      />

      {trialDaysLeft !== null && (
        <div className="card p-4 mb-5 flex flex-wrap items-center justify-between gap-3"
          style={{ borderColor: trialDaysLeft <= 14 ? "var(--warn)" : "var(--border)" }}>
          <div>
            <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>Free trial</div>
            <div className="font-display text-lg font-semibold">
              {trialDaysLeft > 0
                ? <>{trialDaysLeft} day{trialDaysLeft === 1 ? "" : "s"} remaining</>
                : <span style={{ color: "var(--danger)" }}>Trial ended</span>}
            </div>
            {org?.trialEndsAt && (
              <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                {org.name} · ends {fmtDate(org.trialEndsAt)}
              </div>
            )}
          </div>
          {org?.isOrgAdmin && (
            <a href="/upgrade" target="_blank" rel="noopener" className="btn btn-primary">Upgrade plan</a>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Active projects" value={projects.filter((p) => p.status === "active").length} sub={`${projects.length} total`} />
        <Stat label="Portfolio budget" value={money(totalPlanned)} sub={`${pct(totalPlanned ? (totalSpent / totalPlanned) * 100 : 0)} spent`} />
        <Stat label="To sign" value={pendingSignatures.length} sub="requisitions awaiting you" tone={pendingSignatures.length ? "warn" : undefined} />
        <Stat label="Open flags" value={totalFlags} sub="across your projects" tone={totalFlags ? "danger" : "ok"} />
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          <div>
            <h2 className="font-display text-lg font-semibold mb-3">Projects</h2>
            {projects.length === 0 ? (
              <Empty title="No projects yet" hint="Create your first project to get started." />
            ) : (
              <div className="space-y-3">
                {projects.map((p, i) => {
                  const s = summaries[i];
                  const h = s ? healthScore(s) : null;
                  return (
                    <Link key={p.id} href={`/projects/${p.id}`} className="card p-4 block hover:border-brand transition-colors" style={{ borderColor: "var(--border)" }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--surface)", color: "var(--muted)" }}>{p.code}</span>
                            <StatusBadge status={p.status} />
                            {h && <Badge tone={h.tone}>{h.label}</Badge>}
                          </div>
                          <div className="font-display text-base font-semibold mt-1.5 truncate">{p.title}</div>
                          <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{p.donor ?? "—"}</div>
                        </div>
                        {s?.budget && (
                          <div className="text-right shrink-0">
                            <div className="text-sm font-semibold tabular-nums">{money(s.budget.actual, p.currency)}</div>
                            <div className="text-xs" style={{ color: "var(--muted)" }}>of {money(s.budget.planned, p.currency)}</div>
                          </div>
                        )}
                      </div>
                      {s && (
                        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2">
                          <div>
                            <div className="flex justify-between text-xs mb-1"><span style={{ color: "var(--muted)" }}>Progress</span><span>{pct(s.progressPct)}</span></div>
                            <ProgressBar value={s.progressPct} tone="brand" />
                          </div>
                          <div>
                            <div className="flex justify-between text-xs mb-1"><span style={{ color: "var(--muted)" }}>Budget burn</span><span>{pct(s.budget?.burn ?? 0)}</span></div>
                            <ProgressBar value={s.budget?.burn ?? 0} tone={(s.budget?.burn ?? 0) > s.timePct + 15 ? "danger" : "ok"} />
                          </div>
                        </div>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-5">
          {pendingSignatures.length > 0 && (
            <div className="card p-4">
              <h3 className="font-display font-semibold mb-3">Awaiting your signature</h3>
              <div className="space-y-2">
                {pendingSignatures.map((r) => (
                  <Link key={r.id} href={`/projects/${r.projectId}/requisitions/${r.id}`} className="block text-sm hover:underline">
                    <div className="flex justify-between gap-2">
                      <span className="font-mono text-xs">{r.number}</span>
                      <span className="tabular-nums">{money(r.amount)}</span>
                    </div>
                    <div className="text-xs truncate" style={{ color: "var(--muted)" }}>{r.title}</div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          <div className="card p-4">
            <h3 className="font-display font-semibold mb-3">Upcoming meetings</h3>
            {meetings.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>Nothing scheduled.</p> : (
              <div className="space-y-3">
                {meetings.map((m) => (
                  <div key={m.id} className="text-sm">
                    <div className="font-medium">{m.title}</div>
                    <div className="text-xs" style={{ color: "var(--muted)" }}>{fmtDateTime(m.startsAt)}</div>
                    {m.url && <a href={m.url} className="text-xs hover:underline" style={{ color: "var(--info)" }}>Join link</a>}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card p-4">
            <h3 className="font-display font-semibold mb-3">Recent notifications</h3>
            {notifications.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>You're all caught up.</p> : (
              <div className="space-y-3">
                {notifications.map((n) => (
                  <div key={n.id} className="text-sm">
                    <div className="flex items-center gap-2">
                      {!n.read && <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--brand)" }} />}
                      <span className="font-medium">{n.title}</span>
                    </div>
                    <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{label(n.type)} · {fmtDate(n.createdAt)}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
