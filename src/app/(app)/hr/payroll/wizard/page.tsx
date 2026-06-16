import Link from "next/link";
import { requireHrOrg } from "../../_guard";
import { q } from "@/server/db";
import { PageHeader, Badge, Empty } from "@/components/ui";
import { label } from "@/lib/enums";

export default async function PayeWizardIndex() {
  const { orgId } = await requireHrOrg();
  const employees = await q<{ id: string; firstName: string; lastName: string; prefix: string | null; jobTitle: string | null; hasComp: boolean; employmentType: string | null }>(
    `SELECT e.id, e.first_name AS "firstName", e.last_name AS "lastName", e.prefix, e.job_title AS "jobTitle",
            (ec.id IS NOT NULL) AS "hasComp", ec.employment_type AS "employmentType"
     FROM employee e LEFT JOIN employee_compensation ec ON ec.employee_id=e.id
     WHERE e.org_id=$1 ORDER BY e.last_name, e.first_name`, [orgId]
  );
  return (
    <div className="max-w-3xl">
      <PageHeader title="Payroll wizard" subtitle="Set up each employee's pay step by step, with a transparent PAYE breakdown" actions={<Link href="/hr/payroll" className="btn btn-sm">← Payroll</Link>} />
      <p className="text-sm mb-4" style={{ color: "var(--muted)" }}>Pick an employee to walk through their pay basis, allowances, statutory deductions (NSSF &amp; PAYE) and net pay. Each step shows how the figures are reached.</p>
      {employees.length === 0 ? <Empty title="No employees yet" hint="Add employees under HR first." /> : (
        <div className="card" style={{ overflow: "hidden" }}>
          {employees.map((e, i) => (
            <Link key={e.id} href={`/hr/payroll/wizard/${e.id}`} className="hover:border-[var(--brand)]" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderTop: i === 0 ? "none" : "1px solid var(--border)" }}>
              <div>
                <div className="font-medium">{e.prefix ? e.prefix + " " : ""}{e.firstName} {e.lastName}</div>
                <div className="text-xs" style={{ color: "var(--muted)" }}>{e.jobTitle ?? "—"}</div>
              </div>
              <div className="flex items-center gap-2">
                {e.hasComp ? <Badge tone="ok">{label(e.employmentType ?? "staff")} · set up</Badge> : <Badge tone="muted">Not set up</Badge>}
                <span style={{ color: "var(--muted)" }}>→</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
