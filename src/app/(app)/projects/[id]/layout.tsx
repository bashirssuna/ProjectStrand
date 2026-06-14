import { redirect } from "next/navigation";
import Link from "next/link";
import { getProjectAccess } from "@/server/policy";
import { one } from "@/server/db";
import { TabLink } from "@/components/nav";
import { StatusBadge } from "@/components/ui";

export default async function ProjectLayout({
  children, params,
}: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);
  if (!access.permissions.has("project.view")) redirect("/projects");

  const project = await one<{ code: string; title: string; status: string; donor: string | null; mode: string }>(
    `SELECT code, title, status, donor, mode FROM project WHERE id=$1`, [id]
  );
  if (!project) redirect("/projects");

  const base = `/projects/${id}`;
  // Staff (self-service) logins get a deliberately limited view of a project:
  // only Overview, Statement of Work, Work plan, Gantt and Objectives — never
  // budget, spending, requisitions, documents, team, etc.
  const STAFF_TABS = new Set(["", "/sow", "/workplan", "/gantt", "/logframe"]);
  const allTabs: [string, string][] = [
    ["", "Overview"], ["/sow", "Statement of Work"], ["/workplan", "Work plan"],
    ["/gantt", "Gantt"], ["/logframe", "Objectives"], ["/budget", "Budget"],
    ["/spending", "Spending"], ["/requisitions", "Requisitions"], ["/reports", "Reports"],
    ["/documents", "Documents"], ["/team", "Team"], ["/calendar", "Calendar"],
    ["/risks", "Risks"], ["/approvals", "Approvals"], ["/audit", "Audit Log"],
  ];
  const tabs = access.user.isStaff ? allTabs.filter(([p]) => STAFF_TABS.has(p)) : allTabs;

  return (
    <div>
      <div className="mb-5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-xs px-1.5 py-0.5 rounded" style={{ background: "var(--surface)", color: "var(--muted)" }}>{project.code}</span>
          <StatusBadge status={project.status} />
          {project.mode === "simple" && <span className="badge" style={{ color: "var(--muted)" }}>Simple mode</span>}
        </div>
        <h1 className="font-display text-2xl font-semibold mt-1.5">{project.title}</h1>
        <div className="text-sm" style={{ color: "var(--muted)" }}>{project.donor ?? "No donor recorded"}</div>
      </div>

      <div className="border-b mb-6 overflow-x-auto" style={{ borderColor: "var(--border)" }}>
        <nav className="flex gap-1 pb-2">
          {tabs.map(([path, lbl]) => (
            <TabLink key={path} href={`${base}${path}`} exact={path === ""}>{lbl}</TabLink>
          ))}
        </nav>
      </div>

      {children}

      <div className="mt-8 pt-4 border-t text-xs" style={{ borderColor: "var(--border)", color: "var(--muted)" }}>
        Your role: {access.role ?? (access.isSuperAdmin ? "Administrator" : access.user.isStaff ? "Staff (limited access)" : "—")}
        {!access.user.isStaff && <>
          {" · "}
          <Link href={`${base}/import`} className="hover:underline">Import more documents</Link>
        </>}
      </div>
    </div>
  );
}
