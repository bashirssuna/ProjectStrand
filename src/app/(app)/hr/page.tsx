import Link from "next/link";
import { requireHrOrg } from "./_guard";
import { one } from "@/server/db";
import { PageHeader, SectionTitle, Stat } from "@/components/ui";

export default async function HrHome() {
  const { orgId, orgName } = await requireHrOrg();
  const emp = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM employee WHERE org_id=$1 AND status<>'terminated'`, [orgId]))?.c ?? 0;
  const pendingLeave = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM leave_request WHERE org_id=$1 AND status='pending'`, [orgId]))?.c ?? 0;
  const pendingTs = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM timesheet WHERE org_id=$1 AND status='submitted'`, [orgId]))?.c ?? 0;
  return (
    <div>
      <PageHeader title="Human Resources" subtitle={`Staff, leave, timesheets & payroll for ${orgName}`} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Active employees" value={String(emp)} />
        <Stat label="Leave requests pending" value={String(pendingLeave)} tone={pendingLeave ? "warn" : undefined} />
        <Stat label="Timesheets to approve" value={String(pendingTs)} tone={pendingTs ? "warn" : undefined} />
        <Stat label="Module" value="HR" sub="institution-level" />
      </div>
      <SectionTitle>HR tools</SectionTitle>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          ["/hr/employees", "Employees", "Records, contracts, salary & bank details."],
          ["/hr/leave", "Leave", "Requests, approvals and balance tracking."],
          ["/hr/timesheets", "Timesheets", "Log and approve hours, by project."],
          ["/hr/payroll", "Payroll", "Configurable components, runs & payslips."],
          ["/hr/compensation", "Compensation", "Grant model: gross, fringe, NSSF, PAYE & effort."],
          ["/hr/departments", "Departments", "Units staff are assigned to."],
        ].map(([href, t, d]) => (
          <Link key={href} href={href} className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
            <div className="font-display font-semibold">{t}</div>
            <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>{d}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
