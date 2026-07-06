import { getProjectAccess, canManageBudgetBulk } from "@/server/policy";
import { q, one } from "@/server/db";
import { budgetLineRollups } from "@/server/services/budget";
import { addExpenditureAction, editExpenditureAction, deleteExpenditureAction } from "@/app/actions";
import { SectionTitle, Empty, Badge, Field } from "@/components/ui";
import { CancelButton } from "@/components/cancel-button";
import { money, fmtDate, dateInput } from "@/lib/format";
import { blockStaff } from "../_staffblock";

export default async function SpendingPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ exp?: string; experr?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  await blockStaff(id);
  const access = await getProjectAccess(id);
  const canManage = access.permissions.has("budget.manage");
  const senior = canManageBudgetBulk(access);
  const meId = access.user.id;
  const proj = await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [id]);
  const c = proj?.currency ?? "USD";

  const bud = await one<{ id: string }>(`SELECT id FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [id]);
  const lines = bud ? await budgetLineRollups(bud.id) : [];
  const lineName = new Map(lines.map((l) => [l.id, `${l.code} · ${l.description}`]));

  const exps = await q<{
    id: string; amount: number; date: string; reference: string | null; payee: string | null;
    approved: boolean; budgetLineId: string; reqNumber: string | null;
    note: string | null; createdById: string | null; createdByName: string | null;
  }>(
    `SELECT e.id, e.amount, e.date, e.reference, e.payee, e.approved, e.budget_line_id AS "budgetLineId",
            e.note, e.created_by_id AS "createdById", u.name AS "createdByName", r.number AS "reqNumber"
     FROM expenditure e
     LEFT JOIN requisition r ON r.id = e.requisition_id
     LEFT JOIN app_user u ON u.id = e.created_by_id
     WHERE e.project_id=$1 ORDER BY e.date DESC`, [id]
  );
  const total = exps.reduce((s, e) => s + e.amount, 0);
  const canEditRow = (e: { createdById: string | null }) => senior || (!!e.createdById && e.createdById === meId);
  const anyEditable = exps.some(canEditRow);

  return (
    <div className="space-y-7">
      {sp.exp === "edited" && <div className="card p-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Expenditure updated. The change is noted on the record and in the audit log.</div>}
      {sp.exp === "deleted" && <div className="card p-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Expenditure deleted — the amount was returned to its budget line and the deletion recorded in the audit log.</div>}
      {sp.experr === "reason" && <div className="card p-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A reason is required to edit or delete an expenditure.</div>}

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
                <th className="th text-left">Entered by</th>
                <th className="th text-left">Approved</th>
                <th className="th text-right">Amount</th>
                {anyEditable && <th className="th text-right">Edit</th>}
              </tr></thead>
              <tbody>
                {exps.map((e) => (
                  <tr key={e.id}>
                    <td className="td whitespace-nowrap">{fmtDate(e.date)}</td>
                    <td className="td">
                      {lineName.get(e.budgetLineId) ?? <span style={{ color: "var(--muted)" }}>unmapped</span>}
                      {e.note && <div className="text-xs mt-0.5 whitespace-pre-line" style={{ color: "var(--muted)" }}>📝 {e.note}</div>}
                    </td>
                    <td className="td">{e.payee ?? "—"}</td>
                    <td className="td font-mono text-xs">{e.reference ?? "—"}</td>
                    <td className="td font-mono text-xs">{e.reqNumber ?? "—"}</td>
                    <td className="td" style={{ color: e.createdByName ? undefined : "var(--muted)" }}>{e.createdByName ?? "—"}</td>
                    <td className="td">{e.approved ? <Badge tone="ok">approved</Badge> : <Badge tone="warn">unapproved</Badge>}</td>
                    <td className="td text-right tabular-nums font-medium">{money(e.amount, c)}</td>
                    {anyEditable && (
                      <td className="td text-right whitespace-nowrap">
                        {canEditRow(e) ? (
                          <details className="editor inline-block">
                            <summary className="btn btn-sm inline-block">Edit</summary>
                            <div className="editor-panel card p-4 text-left">
                              <div className="font-medium mb-3">Edit expenditure</div>
                              <form action={editExpenditureAction} className="grid gap-2">
                                <input type="hidden" name="projectId" value={id} />
                                <input type="hidden" name="expenditureId" value={e.id} />
                                <Field label="Budget line">
                                  <select name="budgetLineId" defaultValue={e.budgetLineId} className="select">
                                    {lines.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.description}</option>)}
                                  </select>
                                </Field>
                                <div className="grid grid-cols-2 gap-2">
                                  <Field label="Amount"><input type="number" step="0.01" name="amount" defaultValue={e.amount} className="input" /></Field>
                                  <Field label="Date"><input type="date" name="date" defaultValue={dateInput(e.date)} className="input" /></Field>
                                </div>
                                <div className="grid grid-cols-2 gap-2">
                                  <Field label="Payee"><input name="payee" defaultValue={e.payee ?? ""} className="input" /></Field>
                                  <Field label="Reference"><input name="reference" defaultValue={e.reference ?? ""} className="input" /></Field>
                                </div>
                                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="approved" defaultChecked={e.approved} /> Approved</label>
                                <Field label="Reason for change (required)"><textarea name="reason" required rows={2} className="textarea" placeholder="Why is this being changed?" /></Field>
                                <div className="flex gap-2">
                                  <button className="btn btn-primary btn-sm" type="submit">Save changes</button>
                                  <CancelButton className="btn btn-sm">Cancel</CancelButton>
                                </div>
                              </form>
                              <form action={deleteExpenditureAction} className="grid gap-2 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                                <input type="hidden" name="projectId" value={id} />
                                <input type="hidden" name="expenditureId" value={e.id} />
                                <Field label="Reason for deletion (required)"><input name="reason" required className="input" placeholder="Why is this being removed?" /></Field>
                                <button className="btn btn-sm w-full" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete &amp; return {money(e.amount, c)} to the budget line</button>
                              </form>
                            </div>
                          </details>
                        ) : <span style={{ color: "var(--muted)" }}>—</span>}
                      </td>
                    )}
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
            Recording spend re-runs the anomaly engine — over-budget, out-of-period and unapproved spend are flagged automatically. The person who enters a spend (or a PI/Finance lead) can later edit or delete it with a reason.
          </p>
        </div>
      )}
    </div>
  );
}
