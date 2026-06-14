import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money } from "@/lib/format";
import { label } from "@/lib/enums";
import { addEmployeeAction } from "@/app/actions";
import { COMMON_DEPARTMENTS } from "@/lib/departments";

export default async function EmployeesPage({ searchParams }: { searchParams: Promise<{ created?: string; err?: string; view?: string }> }) {
  const { orgId } = await requireHrOrg();
  const sp = await searchParams;
  const view = sp.view === "department" || sp.view === "project" ? sp.view : "list";
  const employees = await q<{ id: string; staffNo: string | null; firstName: string; lastName: string; jobTitle: string | null; department: string | null; contractType: string; basicSalary: number; currency: string; status: string }>(
    `SELECT id, staff_no AS "staffNo", first_name AS "firstName", last_name AS "lastName", job_title AS "jobTitle",
            department, contract_type AS "contractType", basic_salary::float AS "basicSalary", currency, status
     FROM employee WHERE org_id=$1 ORDER BY last_name, first_name`, [orgId]
  );
  const users = await q<{ id: string; name: string; email: string }>(`SELECT u.id, u.name, u.email FROM app_user u JOIN org_membership m ON m.user_id=u.id WHERE m.org_id=$1 ORDER BY u.name`, [orgId]);
  const departments = await q<{ id: string; name: string }>(`SELECT id, name FROM department WHERE org_id=$1 ORDER BY name`, [orgId]);

  // For the grouped views.
  const projAssign = await q<{ projectId: string; code: string; title: string; empId: string; firstName: string; lastName: string; jobTitle: string | null; role: string | null }>(
    `SELECT ep.project_id AS "projectId", p.code, p.title, e.id AS "empId", e.first_name AS "firstName",
            e.last_name AS "lastName", e.job_title AS "jobTitle", ep.role
     FROM employee_project ep JOIN project p ON p.id=ep.project_id JOIN employee e ON e.id=ep.employee_id
     WHERE e.org_id=$1 ORDER BY p.code, e.last_name, e.first_name`, [orgId]
  );
  const byDept = new Map<string, typeof employees>();
  for (const e of employees) {
    const k = e.department?.trim() || "— Unassigned —";
    if (!byDept.has(k)) byDept.set(k, []);
    byDept.get(k)!.push(e);
  }
  const byProj = new Map<string, { code: string; title: string; members: typeof projAssign }>();
  for (const a of projAssign) {
    if (!byProj.has(a.projectId)) byProj.set(a.projectId, { code: a.code, title: a.title, members: [] });
    byProj.get(a.projectId)!.members.push(a);
  }
  const assignedIds = new Set(projAssign.map((a) => a.empId));
  const unassignedToProject = employees.filter((e) => !assignedIds.has(e.id));

  return (
    <div className="max-w-5xl">
      <PageHeader title="Employees" subtitle="Staff records and employment details" actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Employee added.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>First and last name are required.</div>}

      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <SectionTitle>Staff</SectionTitle>
        <div className="flex gap-1">
          <Link href="/hr/employees" className="btn btn-sm" style={view === "list" ? { background: "var(--brand)", color: "var(--brand-fg)" } : undefined}>List</Link>
          <Link href="/hr/employees?view=department" className="btn btn-sm" style={view === "department" ? { background: "var(--brand)", color: "var(--brand-fg)" } : undefined}>By department</Link>
          <Link href="/hr/employees?view=project" className="btn btn-sm" style={view === "project" ? { background: "var(--brand)", color: "var(--brand-fg)" } : undefined}>By project</Link>
        </div>
      </div>

      {employees.length === 0 ? <Empty title="No employees yet" hint="Add your first staff member below." /> : view === "list" ? (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Staff no.</th><th className="th text-left">Name</th><th className="th text-left">Title</th><th className="th text-left">Contract</th><th className="th text-right">Basic</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {employees.map((e) => (
                <tr key={e.id}>
                  <td className="td font-mono text-xs">{e.staffNo ?? "—"}</td>
                  <td className="td">{e.firstName} {e.lastName}{e.department ? <span className="text-xs block" style={{ color: "var(--muted)" }}>{e.department}</span> : null}</td>
                  <td className="td">{e.jobTitle ?? "—"}</td>
                  <td className="td">{label(e.contractType)}</td>
                  <td className="td text-right tabular-nums">{money(e.basicSalary, e.currency)}</td>
                  <td className="td">{e.status === "active" ? <Badge tone="ok">active</Badge> : e.status === "on_leave" ? <Badge tone="info">on leave</Badge> : <Badge tone="muted">{label(e.status)}</Badge>}</td>
                  <td className="td text-right"><Link href={`/hr/employees/${e.id}`} className="btn btn-sm">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : view === "department" ? (
        <div className="space-y-3 mb-6">
          {[...byDept.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([dept, list]) => (
            <div key={dept} className="card p-4">
              <div className="font-display font-semibold mb-2">{dept} <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>· {list.length} {list.length === 1 ? "person" : "people"}</span></div>
              <div>
                {list.map((e) => (
                  <div key={e.id} className="flex items-center justify-between py-1.5 border-t" style={{ borderColor: "var(--border)" }}>
                    <div><span className="font-medium">{e.firstName} {e.lastName}</span>{e.jobTitle && <span className="text-xs" style={{ color: "var(--muted)" }}> · {e.jobTitle}</span>}</div>
                    <Link href={`/hr/employees/${e.id}`} className="btn btn-sm">Open</Link>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3 mb-6">
          {[...byProj.values()].map((p) => (
            <div key={p.code} className="card p-4">
              <div className="font-display font-semibold mb-2"><span style={{ color: "var(--brand)" }}>{p.code}</span> {p.title} <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>· {p.members.length} {p.members.length === 1 ? "person" : "people"}</span></div>
              <div>
                {p.members.map((m) => (
                  <div key={m.empId} className="flex items-center justify-between py-1.5 border-t" style={{ borderColor: "var(--border)" }}>
                    <div><span className="font-medium">{m.firstName} {m.lastName}</span>{m.role && <span className="text-xs" style={{ color: "var(--muted)" }}> · {m.role}</span>}</div>
                    <Link href={`/hr/employees/${m.empId}`} className="btn btn-sm">Open</Link>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {byProj.size === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>No project assignments yet.</p>}
          {unassignedToProject.length > 0 && (
            <div className="card p-4">
              <div className="font-display font-semibold mb-2">— Not on any project — <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>· {unassignedToProject.length}</span></div>
              <div>
                {unassignedToProject.map((e) => (
                  <div key={e.id} className="flex items-center justify-between py-1.5 border-t" style={{ borderColor: "var(--border)" }}>
                    <div><span className="font-medium">{e.firstName} {e.lastName}</span>{e.jobTitle && <span className="text-xs" style={{ color: "var(--muted)" }}> · {e.jobTitle}</span>}</div>
                    <Link href={`/hr/employees/${e.id}`} className="btn btn-sm">Open</Link>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <SectionTitle>Add an employee</SectionTitle>
      <form action={addEmployeeAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <Field label="Prefix"><select name="prefix" className="select"><option value="">—</option><option>Dr</option><option>Prof</option><option>Assoc. Prof</option><option>Assist. Prof</option><option>Mr</option><option>Ms</option><option>Mrs</option><option>Sr</option><option>Rev</option></select></Field>
        <Field label="First name"><input name="firstName" required className="input" /></Field>
        <Field label="Last name"><input name="lastName" required className="input" /></Field>
        <Field label="Staff no."><input name="staffNo" className="input" /></Field>
        <Field label="Job title"><input name="jobTitle" className="input" /></Field>
        <Field label="Department"><input name="departmentName" list="dept-options" className="input" placeholder="Pick or type a department…" />
          <datalist id="dept-options">
            {Array.from(new Map([...departments.map((d) => d.name), ...COMMON_DEPARTMENTS].map((n) => [n.toLowerCase(), n])).values()).map((n) => <option key={n} value={n} />)}
          </datalist>
        </Field>
        <Field label="Contract type">
          <select name="contractType" className="select"><option value="permanent">Permanent</option><option value="fixed_term">Fixed term</option><option value="casual">Casual</option><option value="consultant">Consultant</option><option value="intern">Intern</option></select>
        </Field>
        <Field label="Basic salary"><input type="number" step="0.01" name="basicSalary" className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue="USD" className="input" /></Field>
        <Field label="Pay frequency">
          <select name="payFrequency" className="select"><option value="monthly">Monthly</option><option value="weekly">Weekly</option><option value="daily">Daily</option></select>
        </Field>
        <Field label="Email"><input name="email" className="input" /></Field>
        <Field label="Phone"><input name="phone" className="input" /></Field>
        <Field label="Annual leave (days)"><input type="number" step="0.5" name="annualLeaveDays" defaultValue={21} className="input" /></Field>
        <Field label="Bank name"><input name="bankName" className="input" /></Field>
        <Field label="Bank account"><input name="bankAccount" className="input" /></Field>
        <Field label="Mobile money"><input name="mobileMoney" className="input" /></Field>
        <Field label="Start date"><input type="date" name="startDate" className="input" /></Field>
        <Field label="Link to login (optional)">
          <select name="userId" className="select"><option value="">— not linked —</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}</select>
        </Field>
        <label className="flex items-center gap-2 text-sm self-end pb-2">
          <input type="checkbox" name="createLogin" /> Create self-service login &amp; email invite
        </label>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Add employee</button></div>
      </form>
    </div>
  );
}
