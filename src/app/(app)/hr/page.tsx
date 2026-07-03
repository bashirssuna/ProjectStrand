import Link from "next/link";
import { requireHrOrg } from "./_guard";
import { one } from "@/server/db";
import { PageHeader, SectionTitle, Stat, ToolCard } from "@/components/ui";
import type { IconName } from "@/components/icons";

export default async function HrHome() {
  const { orgId, orgName } = await requireHrOrg();
  const emp = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM employee WHERE org_id=$1 AND status<>'terminated'`, [orgId]))?.c ?? 0;
  const pendingLeave = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM leave_request WHERE org_id=$1 AND status='pending'`, [orgId]))?.c ?? 0;
  const pendingTs = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM timesheet WHERE org_id=$1 AND status='submitted'`, [orgId]))?.c ?? 0;
  // Staff whose contract end date falls within the next 60 days, or has already passed.
  const expiring = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM employee WHERE org_id=$1 AND status<>'terminated' AND end_date IS NOT NULL AND end_date <= (CURRENT_DATE + INTERVAL '60 days')`, [orgId]))?.c ?? 0;
  return (
    <div>
      <PageHeader title="Human Resources" subtitle={`Staff, leave, timesheets & payroll for ${orgName}`} actions={<Link href="/operations" className="btn btn-sm">Institutional overview →</Link>} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Active employees" value={String(emp)} />
        <Stat label="Leave requests pending" value={String(pendingLeave)} tone={pendingLeave ? "warn" : undefined} />
        <Stat label="Timesheets to approve" value={String(pendingTs)} tone={pendingTs ? "warn" : undefined} />
        <Link href="/hr/employees" style={{ display: "block" }}>
          <Stat label="Contracts expiring soon" value={String(expiring)} sub="within 60 days / overdue" tone={expiring ? "warn" : undefined} />
        </Link>
      </div>
      <SectionTitle>HR tools</SectionTitle>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {([
          ["/hr/recruitment", "id", "Recruitment", "Job openings, candidates, interviews & offers."],
          ["/hr/appraisals", "audit", "Appraisals", "Review cycles, objectives, ratings & sign-off."],
          ["/hr/relations", "collab", "Employee relations", "Grievances & disciplinary cases with audit trail."],
          ["/hr/surveys", "revenue", "Engagement surveys", "Anonymous staff satisfaction surveys & results."],
          ["/hr/checklists", "check", "Onboarding & exit", "Induction, clearance & handover checklists."],
          ["/hr/employees", "hr", "Employees", "Records, contracts, salary & bank details."],
          ["/hr/leave", "leave", "Leave", "Requests, approvals and balance tracking."],
          ["/hr/timesheets", "clock", "Timesheets", "Log and approve hours, by project."],
          ["/hr/payroll", "slip", "Payroll & compensation", "Pay components, the grant compensation model, runs & payslips."],
          ["/hr/departments", "building", "Departments", "Units staff are assigned to."],
          ["/organization/access", "access", "Access management", "Now under Organisation → manage roles & permissions by person or department."],
        ] as [string, IconName, string, string][]).map(([href, icon, t, d]) => (
          <ToolCard key={href} href={href} icon={icon} title={t} desc={d} />
        ))}
      </div>
    </div>
  );
}
