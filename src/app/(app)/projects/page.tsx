import Link from "next/link";
import { requireUser } from "@/server/auth";
import { listProjectsForUser, getProjectSummary, healthScore } from "@/server/services/projects";
import { canCreateProjects } from "@/server/policy";
import { PageHeader, Badge, StatusBadge, ProgressBar, Empty } from "@/components/ui";
import { money } from "@/lib/format";
import { label } from "@/lib/enums";

const FILTERS: [string, string][] = [
  ["all", "All"], ["active", "Active"], ["on_hold", "On Hold"],
  ["completed", "Completed"], ["draft", "Draft"], ["archived", "Archived"],
];

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<{ status?: string; deleted?: string }> }) {
  const user = await requireUser();
  const { status = "all", deleted } = await searchParams;
  const all = await listProjectsForUser(user.id, user.isSuperAdmin);
  const mayCreate = await canCreateProjects(user.id, user.isSuperAdmin);
  const summaries = await Promise.all(all.map((p) => getProjectSummary(p.id)));
  const rows = all.map((p, i) => ({ p, s: summaries[i] }));

  const counts: Record<string, number> = { all: rows.length };
  for (const { p } of rows) counts[p.status] = (counts[p.status] ?? 0) + 1;
  const filtered = status === "all" ? rows : rows.filter((r) => r.p.status === status);

  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle={user.isSuperAdmin ? "Every project across the organisation." : "Projects you're a member of."}
        actions={mayCreate ? <Link href="/projects/new" className="btn btn-primary">+ New project</Link> : undefined}
      />
      {deleted && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Project {decodeURIComponent(deleted)} and everything connected to it were permanently deleted.</div>}

      <div className="flex flex-wrap gap-1.5 mb-5">
        {FILTERS.map(([key, name]) => {
          const active = status === key;
          return (
            <Link
              key={key}
              href={key === "all" ? "/projects" : `/projects?status=${key}`}
              className="rounded-lg px-3 py-1.5 text-sm transition-colors"
              style={active
                ? { background: "var(--brand)", color: "var(--brand-fg)", fontWeight: 600 }
                : { color: "var(--muted)", border: "1px solid var(--border)" }}
            >
              {name}{counts[key] ? <span className="ml-1.5 text-xs opacity-70">{counts[key]}</span> : null}
            </Link>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <Empty title="No projects yet" hint={mayCreate ? "Create your first project — you can upload existing documents and let Strand draft the pages for you." : "You haven't been added to any projects yet."} />
      ) : filtered.length === 0 ? (
        <Empty title={`No ${label(status).toLowerCase()} projects`} hint="Try a different filter." />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th text-left">Project</th>
                <th className="th text-left">Status</th>
                <th className="th text-left">Health</th>
                <th className="th text-right">Progress</th>
                <th className="th text-right">Budget</th>
                <th className="th text-right">Spent</th>
                <th className="th text-center">Flags</th>
                <th className="th text-left">Your role</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(({ p, s }) => {
                const h = s ? healthScore(s) : null;
                return (
                  <tr key={p.id} className="hover:bg-[var(--surface)]">
                    <td className="td">
                      <Link href={`/projects/${p.id}`} className="block">
                        <div className="font-mono text-xs" style={{ color: "var(--muted)" }}>{p.code}</div>
                        <div className="font-medium">{p.title}</div>
                        <div className="text-xs" style={{ color: "var(--muted)" }}>{p.donor ?? "—"}</div>
                      </Link>
                    </td>
                    <td className="td"><StatusBadge status={p.status} /></td>
                    <td className="td">{h ? <Badge tone={h.tone}>{h.label}</Badge> : "—"}</td>
                    <td className="td" style={{ minWidth: 120 }}>{s ? <ProgressBar value={s.progressPct} showLabel /> : "—"}</td>
                    <td className="td text-right tabular-nums">{s?.budget ? money(s.budget.planned, p.currency) : "—"}</td>
                    <td className="td text-right tabular-nums">{s?.budget ? money(s.budget.actual, p.currency) : "—"}</td>
                    <td className="td text-center">
                      {s && s.counts.openFlags > 0 ? <Badge tone="danger">{s.counts.openFlags}</Badge> : <span style={{ color: "var(--muted)" }}>—</span>}
                    </td>
                    <td className="td">{p.role ? label(p.role) : <span style={{ color: "var(--muted)" }}>Admin</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
