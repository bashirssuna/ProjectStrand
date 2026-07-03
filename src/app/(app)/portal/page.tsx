import Link from "next/link";
import { requirePortalEmployee } from "./_guard";
import { q, one } from "@/server/db";
import { leaveBalance } from "@/server/services/hr";
import { PageHeader, SectionTitle, Stat, Empty, ToolCard } from "@/components/ui";
import type { IconName } from "@/components/icons";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

export default async function PortalHome() {
  const { employeeId, name } = await requirePortalEmployee();
  const lb = await leaveBalance(employeeId);
  const pendingLeave = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM leave_request WHERE employee_id=$1 AND status='pending'`, [employeeId]))?.c ?? 0;
  const tsThisMonth = (await one<{ s: number }>(`SELECT COALESCE(SUM(hours),0)::float s FROM timesheet WHERE employee_id=$1 AND date_trunc('month', work_date)=date_trunc('month', CURRENT_DATE)`, [employeeId]))?.s ?? 0;
  // Projects this employee can see: either their login is a project_member, OR
  // they've been assigned to the project in HR (employee_project). Both surface
  // the same limited self-service view.
  const projects = await q<{ id: string; code: string; title: string; role: string | null }>(
    `SELECT DISTINCT p.id, p.code, p.title, ep.role
     FROM project p
     LEFT JOIN employee_project ep ON ep.project_id = p.id AND ep.employee_id = $1
     WHERE p.id IN (
       SELECT pm.project_id FROM project_member pm JOIN employee e ON e.user_id = pm.user_id WHERE e.id = $1
       UNION
       SELECT ep2.project_id FROM employee_project ep2 WHERE ep2.employee_id = $1
     )
     ORDER BY p.code`, [employeeId]
  );

  return (
    <div>
      <PageHeader title={`Welcome, ${name.split(" ")[0]}`} subtitle="Your staff self-service portal" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Leave remaining" value={`${lb.remaining} days`} sub={`of ${lb.entitlement}`} />
        <Stat label="Pending leave" value={String(pendingLeave)} tone={pendingLeave ? "warn" : undefined} />
        <Stat label="Hours this month" value={String(tsThisMonth)} />
        <Stat label="My projects" value={String(projects.length)} />
      </div>

      <SectionTitle>Quick actions</SectionTitle>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3.5 mb-7">
        {([
          ["/portal/timesheets", "clock", "Fill timesheet", "Log your hours."],
          ["/portal/leave", "leave", "Request leave", "Submit a leave request."],
          ["/portal/appraisals", "audit", "My appraisals", "View, complete & sign your reviews."],
          ["/portal/onboarding", "check", "Onboarding & exit", "Track and tick your checklists."],
          ["/portal/requests", "procurement", "Purchase request", "Request something to buy."],
          ["/portal/profile", "id", "My profile & CV", "Update details & documents."],
        ] as [string, IconName, string, string][]).map(([href, icon, t, d]) => (
          <ToolCard key={href} href={href} icon={icon} title={t} desc={d} />
        ))}
      </div>

      <SectionTitle>My projects</SectionTitle>
      {projects.length === 0 ? <Empty title="No projects assigned" hint="When you're added to a project, it appears here with a limited view." /> : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
              <div className="font-mono text-xs" style={{ color: "var(--brand)" }}>{p.code}</div>
              <div className="font-medium mt-1">{p.title}</div>
              {p.role && <div className="text-xs mt-1" style={{ color: "var(--fg)" }}>Your role: {p.role}</div>}
              <div className="text-xs mt-2" style={{ color: "var(--muted)" }}>Overview · SOW · Workplan · Gantt · Objectives</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
