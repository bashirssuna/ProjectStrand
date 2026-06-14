import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Empty } from "@/components/ui";
import { addDepartmentAction } from "@/app/actions";

export default async function DepartmentsPage({ searchParams }: { searchParams: Promise<{ created?: string; err?: string }> }) {
  const { orgId } = await requireHrOrg();
  const sp = await searchParams;
  const employees = await q<{ id: string; firstName: string; lastName: string }>(`SELECT id, first_name AS "firstName", last_name AS "lastName" FROM employee WHERE org_id=$1 AND status<>'terminated' ORDER BY last_name`, [orgId]);
  const departments = await q<{ id: string; name: string; description: string | null; head: string | null; headcount: number }>(
    `SELECT d.id, d.name, d.description, (he.first_name || ' ' || he.last_name) AS head,
            (SELECT COUNT(*)::int FROM employee e WHERE e.department_id=d.id AND e.status<>'terminated') AS headcount
     FROM department d LEFT JOIN employee he ON he.id=d.head_employee_id WHERE d.org_id=$1 ORDER BY d.name`, [orgId]
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title="Departments" subtitle="Organisational units staff are assigned to" actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Department created.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Department name is required.</div>}

      <SectionTitle>Departments</SectionTitle>
      {departments.length === 0 ? <Empty title="No departments yet" hint="Create your first department below, then assign staff to it from their profile." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Name</th><th className="th text-left">Head</th><th className="th text-right">Staff</th><th className="th text-left">Description</th></tr></thead>
            <tbody>{departments.map((d) => (<tr key={d.id}><td className="td font-medium">{d.name}</td><td className="td">{d.head ?? "—"}</td><td className="td text-right tabular-nums">{d.headcount}</td><td className="td">{d.description ?? "—"}</td></tr>))}</tbody>
          </table>
        </div>
      )}

      <SectionTitle>Add a department</SectionTitle>
      <form action={addDepartmentAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <Field label="Name"><input name="name" required className="input" placeholder="e.g. Field Operations" /></Field>
        <Field label="Head (optional)"><select name="headEmployeeId" className="select"><option value="">— none —</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select></Field>
        <Field label="Description"><input name="description" className="input" /></Field>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Add department</button></div>
      </form>
    </div>
  );
}
