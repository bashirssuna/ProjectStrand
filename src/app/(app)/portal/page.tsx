import Link from "next/link";
import { requirePortalEmployee } from "./_guard";
import { q, one } from "@/server/db";
import { leaveBalance } from "@/server/services/hr";
import { PageHeader, SectionTitle, Stat, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

export default async function PortalHome() {
  const { employeeId, name } = await requirePortalEmployee();
  const lb = await leaveBalance(employeeId);
  const pendingLeave = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM leave_request WHERE employee_id=$1 AND status='pending'`, [employeeId]))?.c ?? 0;
  const tsThisMonth = (await one<{ s: number }>(`SELECT COALESCE(SUM(hours),0)::float s FROM timesheet WHERE employee_id=$1 AND date_trunc('month', work_date)=date_trunc('month', CURRENT_DATE)`, [employeeId]))?.s ?? 0;
  // projects this employee can see (assigned via project_member through their user)
  const projects = await q<{ id: string; code: string; title: string }>(
    `SELECT p.id, p.code, p.title FROM project p
     JOIN project_member pm ON pm.project_id=p.id
     JOIN employee e ON e.user_id=pm.user_id WHERE e.id=$1 ORDER BY p.created_at DESC`, [employeeId]
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
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-7">
        {[
          ["/portal/timesheets", "Fill timesheet", "Log your hours."],
          ["/portal/leave", "Request leave", "Submit a leave request."],
          ["/portal/requests", "Purchase request", "Request something to buy."],
          ["/portal/profile", "My profile & CV", "Update details & documents."],
        ].map(([href, t, d]) => (
          <Link key={href} href={href} className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
            <div className="font-display font-semibold">{t}</div>
            <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>{d}</div>
          </Link>
        ))}
      </div>

      <SectionTitle>My projects</SectionTitle>
      {projects.length === 0 ? <Empty title="No projects assigned" hint="When you're added to a project, it appears here with a limited view." /> : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {projects.map((p) => (
            <Link key={p.id} href={`/projects/${p.id}`} className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
              <div className="font-mono text-xs" style={{ color: "var(--brand)" }}>{p.code}</div>
              <div className="font-medium mt-1">{p.title}</div>
              <div className="text-xs mt-2" style={{ color: "var(--muted)" }}>Overview · SOW · Workplan · Gantt · Objectives</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
