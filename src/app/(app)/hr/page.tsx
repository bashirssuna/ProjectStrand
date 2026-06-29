import Link from "next/link";
import { requireHrOrg } from "./_guard";
import { one } from "@/server/db";
import { PageHeader, SectionTitle, Stat } from "@/components/ui";

export default async function HrHome() {
  const { orgId, orgName } = await requireHrOrg();
  const emp = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM employee WHERE org_id=$1 AND status<>'terminated'`, [orgId]))?.c ?? 0;
  const pendingLeave = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM leave_request WHERE org_id=$1 AND status='pending'`, [orgId]))?.c ?? 0;
  const pendingTs = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM timesheet WHERE org_id=$1 AND status='submitted'`, [orgId]))?.c ?? 0;
  // Staff whose contract end date falls within the next 60 days, or has already passed.
  const expiring = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM employee WHERE org_id=$1 AND status<>'terminated' AND end_date IS NOT NULL AND end_date <= (CURRENT_DATE + INTERVAL '60 days')`, [orgId]))?.c ?? 0;
  return (
    <div>
      <PageHeader title="Human Resources" subtitle={`Staff, leave, timesheets & payroll for ${orgName}`} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Active employees" value={String(emp)} />
        <Stat label="Leave requests pending" value={String(pendingLeave)} tone={pendingLeave ? "warn" : undefined} />
        <Stat label="Timesheets to approve" value={String(pendingTs)} tone={pendingTs ? "warn" : undefined} />
        <Link href="/hr/employees" style={{ display: "block" }}>
          <Stat label="Contracts expiring soon" value={String(expiring)} sub="within 60 days / overdue" tone={expiring ? "warn" : undefined} />
        </Link>
      </div>
      <SectionTitle>HR tools</SectionTitle>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          ["/hr/recruitment", "Recruitment", "Job openings, candidates, interviews & offers."],
          ["/hr/appraisals", "Appraisals", "Review cycles, objectives, ratings & sign-off."],
          ["/hr/relations", "Employee relations", "Grievances & disciplinary cases with audit trail."],
          ["/hr/checklists", "Onboarding & exit", "Induction, clearance & handover checklists."],
          ["/hr/employees", "Employees", "Records, contracts, salary & bank details."],
          ["/hr/leave", "Leave", "Requests, approvals and balance tracking."],
          ["/hr/timesheets", "Timesheets", "Log and approve hours, by project."],
          ["/hr/payroll", "Payroll & compensation", "Pay components, the grant compensation model, runs & payslips."],
          ["/hr/departments", "Departments", "Units staff are assigned to."],
          ["/organization/access", "Access management", "Now under Organisation → manage roles & permissions by person or department."],
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
