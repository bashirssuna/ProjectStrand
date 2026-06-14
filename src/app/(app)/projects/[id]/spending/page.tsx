import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { budgetLineRollups } from "@/server/services/budget";
import { addExpenditureAction } from "@/app/actions";
import { SectionTitle, Empty, Badge, Field } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { blockStaff } from "../_staffblock";

export default async function SpendingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await blockStaff(id);
  const access = await getProjectAccess(id);
  const canManage = access.permissions.has("budget.manage");
  const proj = await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [id]);
  const c = proj?.currency ?? "USD";

  const bud = await one<{ id: string }>(`SELECT id FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [id]);
  const lines = bud ? await budgetLineRollups(bud.id) : [];
  const lineName = new Map(lines.map((l) => [l.id, `${l.code} · ${l.description}`]));

  const exps = await q<{
    id: string; amount: number; date: string; reference: string | null; payee: string | null;
    approved: boolean; budgetLineId: string; reqNumber: string | null;
  }>(
    `SELECT e.id, e.amount, e.date, e.reference, e.payee, e.approved, e.budget_line_id AS "budgetLineId",
            r.number AS "reqNumber"
     FROM expenditure e LEFT JOIN requisition r ON r.id = e.requisition_id
     WHERE e.project_id=$1 ORDER BY e.date DESC`, [id]
  );
  const total = exps.reduce((s, e) => s + e.amount, 0);

  return (
    <div className="space-y-7">
      <div>
        <SectionTitle>Expenditure ledger <span className="text-sm font-normal" style={{ color: "var(--muted)" }}>· {money(total, c)} recorded</span></SectionTitle>
        {exps.length === 0 ? (
          <Empty title="No expenditure recorded" hint={canManage ? "Record spend below, or it will appear here when requisitions are retired." : "No spend recorded yet."} />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Date</th>
                <th className="th text-left">Budget line</th>
                <th className="th text-left">Payee</th>
                <th className="th text-left">Reference</th>
                <th className="th text-left">Requisition</th>
                <th className="th text-left">Approved</th>
                <th className="th text-right">Amount</th>
              </tr></thead>
              <tbody>
                {exps.map((e) => (
                  <tr key={e.id}>
                    <td className="td whitespace-nowrap">{fmtDate(e.date)}</td>
                    <td className="td">{lineName.get(e.budgetLineId) ?? <span style={{ color: "var(--muted)" }}>unmapped</span>}</td>
                    <td className="td">{e.payee ?? "—"}</td>
                    <td className="td font-mono text-xs">{e.reference ?? "—"}</td>
                    <td className="td font-mono text-xs">{e.reqNumber ?? "—"}</td>
                    <td className="td">{e.approved ? <Badge tone="ok">approved</Badge> : <Badge tone="warn">unapproved</Badge>}</td>
                    <td className="td text-right tabular-nums font-medium">{money(e.amount, c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canManage && lines.length > 0 && (
        <div>
          <SectionTitle>Record expenditure</SectionTitle>
          <form action={addExpenditureAction} className="card p-4 grid sm:grid-cols-6 gap-3 items-end">
            <input type="hidden" name="projectId" value={id} />
            <div className="sm:col-span-2"><Field label="Budget line">
              <select name="budgetLineId" required className="select">
                {lines.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.description}</option>)}
              </select>
            </Field></div>
            <Field label="Amount"><input type="number" step="0.01" name="amount" required className="input" /></Field>
            <Field label="Date"><input type="date" name="date" className="input" defaultValue={new Date().toISOString().slice(0, 10)} /></Field>
            <Field label="Payee"><input name="payee" className="input" /></Field>
            <div className="flex gap-3 items-center">
              <Field label="Reference"><input name="reference" className="input" /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="approved" /> Pre-approved spend
            </label>
            <div className="sm:col-span-4 flex justify-end">
              <button className="btn btn-primary" type="submit">Record expenditure</button>
            </div>
          </form>
          <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
            Recording spend re-runs the anomaly engine — over-budget, out-of-period and unapproved spend are flagged automatically.
          </p>
        </div>
      )}
    </div>
  );
}
