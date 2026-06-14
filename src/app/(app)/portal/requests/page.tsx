import { requirePortalEmployee } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, StatusBadge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { myCreatePurchaseRequestAction } from "@/app/actions";

export default async function MyRequests({ searchParams }: { searchParams: Promise<{ created?: string; err?: string }> }) {
  const { employeeId, userId } = await requirePortalEmployee() as any;
  const sp = await searchParams;
  const { one } = await import("@/server/db");
  const me = (await one<{ uid: string }>(`SELECT user_id AS uid FROM employee WHERE id=$1`, [employeeId]))!;
  const projects = await q<{ id: string; code: string; title: string }>(
    `SELECT p.id, p.code, p.title FROM project p JOIN project_member pm ON pm.project_id=p.id WHERE pm.user_id=$1 ORDER BY p.created_at DESC`, [me.uid]
  );
  const mine = await q<{ number: string; title: string; estimatedTotal: number; currency: string; status: string; createdAt: string }>(
    `SELECT number, title, estimated_total::float AS "estimatedTotal", currency, status, created_at AS "createdAt" FROM purchase_request WHERE requested_by=$1 ORDER BY created_at DESC LIMIT 20`, [me.uid]
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title="My purchase requests" subtitle="Request items to be bought" />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Request submitted for approval.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Title and item description are required.</div>}

      <SectionTitle>Raise a request</SectionTitle>
      <form action={myCreatePurchaseRequestAction} className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
        <div className="sm:col-span-2"><Field label="Title"><input name="title" required className="input" placeholder="e.g. Stationery for training" /></Field></div>
        <Field label="Project (optional)"><select name="projectId" className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></Field>
        <div className="sm:col-span-3"><Field label="Item description"><input name="itemDescription" required className="input" /></Field></div>
        <Field label="Quantity"><input type="number" step="0.01" name="quantity" defaultValue={1} className="input" /></Field>
        <Field label="Unit"><input name="unit" className="input" placeholder="pcs" /></Field>
        <Field label="Est. unit cost"><input type="number" step="0.01" name="unitCost" className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue="USD" className="input" /></Field>
        <Field label="Needed by"><input type="date" name="neededBy" className="input" /></Field>
        <div className="sm:col-span-3"><Field label="Justification"><textarea name="justification" rows={2} className="textarea" /></Field></div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Submit request</button></div>
      </form>

      <SectionTitle>My requests</SectionTitle>
      {mine.length === 0 ? <Empty title="No requests yet" hint="Raise one above; it goes to procurement for approval." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Number</th><th className="th text-left">Title</th><th className="th text-left">Date</th><th className="th text-left">Status</th><th className="th text-right">Est. total</th></tr></thead>
            <tbody>{mine.map((r, i) => (<tr key={i}><td className="td font-mono text-xs">{r.number}</td><td className="td">{r.title}</td><td className="td">{fmtDate(r.createdAt)}</td><td className="td"><StatusBadge status={r.status} /></td><td className="td text-right tabular-nums">{money(r.estimatedTotal, r.currency)}</td></tr>))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
