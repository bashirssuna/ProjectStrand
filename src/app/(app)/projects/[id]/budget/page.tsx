import Link from "next/link";
import { getProjectAccess } from "@/server/policy";
import { one, q } from "@/server/db";
import { budgetLineRollups, budgetSummary } from "@/server/services/budget";
import { addBudgetLineAction, convertBudgetCurrencyAction, updateBudgetLineAction, deleteBudgetLineAction, clearBudgetLinesAction } from "@/app/actions";
import { Stat, SectionTitle, Empty, ProgressBar, Field, Badge } from "@/components/ui";
import { money, pct, fmtDate } from "@/lib/format";

export default async function BudgetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);
  const canManage = access.permissions.has("budget.manage");
  const proj = await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [id]);
  const c = proj?.currency ?? "USD";

  const bud = await one<{ id: string; name: string; kind: string }>(
    `SELECT id, name, kind FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [id]
  );
  const lines = bud ? await budgetLineRollups(bud.id) : [];
  const sum = bud ? await budgetSummary(bud.id) : null;

  // change history per line (previous values, who changed them, when)
  const revs = await q<{
    budgetLineId: string; code: string; description: string; unitCost: number;
    quantity: number; planned: number; action: string; changedByName: string | null; changedAt: string;
  }>(
    `SELECT budget_line_id AS "budgetLineId", code, description, unit_cost AS "unitCost",
            quantity, planned, action, changed_by_name AS "changedByName", changed_at AS "changedAt"
     FROM budget_line_revision WHERE project_id=$1 ORDER BY changed_at DESC`, [id]
  );
  const revsByLine = new Map<string, typeof revs>();
  for (const r of revs) {
    const arr = revsByLine.get(r.budgetLineId) ?? [];
    arr.push(r);
    revsByLine.set(r.budgetLineId, arr);
  }

  return (
    <div className="space-y-7">
      {sum && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Stat label="Planned" value={money(sum.planned, c)} />
          <Stat label="Committed" value={money(sum.committed, c)} sub="reserved by approvals" />
          <Stat label="Spent" value={money(sum.actual, c)} />
          <Stat label="Remaining" value={money(sum.remaining, c)} tone={sum.remaining < 0 ? "danger" : "ok"} />
          <Stat label="Burn rate" value={pct(sum.burn)} tone={sum.burn > 90 ? "warn" : undefined} />
        </div>
      )}

      <div>
        <SectionTitle action={canManage ? (
          <div className="flex items-center gap-2">
            {lines.length > 0 && (
              <form action={clearBudgetLinesAction}><input type="hidden" name="projectId" value={id} />
                <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Clear all</button>
              </form>
            )}
            <Link href={`/projects/${id}/import`} className="btn btn-sm">Import from file</Link>
          </div>
        ) : undefined}>
          Budget lines {bud && <span className="text-sm font-normal" style={{ color: "var(--muted)" }}>· {bud.name}</span>}
        </SectionTitle>
        {lines.length === 0 ? (
          <Empty title="No budget yet" hint={canManage ? "Add lines below or import a budget spreadsheet." : "No budget lines recorded."} />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Code</th>
                <th className="th text-left">Description</th>
                <th className="th text-left">Category</th>
                <th className="th text-right">Unit cost</th>
                <th className="th text-right">Qty</th>
                <th className="th text-right">Planned</th>
                <th className="th text-right">Committed</th>
                <th className="th text-right">Spent</th>
                <th className="th text-right">Remaining</th>
                <th className="th text-left" style={{ width: 120 }}>Burn</th>
                {canManage && <th className="th text-right">Edit</th>}
              </tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td className="td font-mono text-xs">{l.code}</td>
                    <td className="td">{l.description}
                      {l.costType === "indirect" && <Badge tone="muted">indirect</Badge>}
                    </td>
                    <td className="td" style={{ color: l.categoryName ? undefined : "var(--muted)" }}>{l.categoryName ?? "—"}</td>
                    <td className="td text-right tabular-nums">{money(l.unitCost, c)}</td>
                    <td className="td text-right tabular-nums">{l.quantity}</td>
                    <td className="td text-right tabular-nums font-medium">{money(l.planned, c)}</td>
                    <td className="td text-right tabular-nums">{money(l.committed, c)}</td>
                    <td className="td text-right tabular-nums">{money(l.actual, c)}</td>
                    <td className="td text-right tabular-nums" style={{ color: l.remaining < 0 ? "var(--danger)" : undefined }}>{money(l.remaining, c)}</td>
                    <td className="td"><ProgressBar value={l.burn} tone={l.burn > 100 ? "danger" : l.burn > 90 ? "warn" : "ok"} /></td>
                    {canManage && (
                      <td className="td text-right whitespace-nowrap">
                        <details className="editor inline-block">
                          <summary className="btn btn-sm inline-block">Edit</summary>
                          <div className="editor-panel card p-4 text-left">
                            <div className="font-medium mb-3">Edit budget line</div>
                            <form action={updateBudgetLineAction} className="grid gap-2">
                              <input type="hidden" name="projectId" value={id} />
                              <input type="hidden" name="lineId" value={l.id} />
                              <Field label="Code"><input name="code" defaultValue={l.code} className="input" /></Field>
                              <Field label="Description"><input name="description" defaultValue={l.description} className="input" /></Field>
                              <div className="grid grid-cols-2 gap-2">
                                <Field label="Unit cost"><input name="unitCost" type="number" step="any" defaultValue={l.unitCost} className="input" /></Field>
                                <Field label="Qty"><input name="quantity" type="number" step="any" defaultValue={l.quantity} className="input" /></Field>
                              </div>
                              <button className="btn btn-primary btn-sm" type="submit">Save changes</button>
                            </form>
                            <form action={deleteBudgetLineAction} className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                              <input type="hidden" name="projectId" value={id} />
                              <input type="hidden" name="lineId" value={l.id} />
                              <button className="btn btn-sm w-full" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete this line</button>
                            </form>
                            <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                              <div className="text-xs font-medium mb-2" style={{ color: "var(--muted)" }}>Change history</div>
                              {(revsByLine.get(l.id) ?? []).length === 0 ? (
                                <div className="text-xs" style={{ color: "var(--muted)" }}>No prior changes — current planned {money(l.planned, c)}.</div>
                              ) : (
                                <ul className="space-y-2">
                                  {(revsByLine.get(l.id) ?? []).map((r, i) => (
                                    <li key={i} className="text-xs" style={{ color: "var(--muted)" }}>
                                      <span style={{ color: r.action === "deleted" ? "var(--danger)" : "var(--fg)" }}>
                                        {r.action === "deleted" ? "Removed" : "Was"}: {money(r.planned, c)}
                                      </span>{" "}
                                      ({money(r.unitCost, c)} × {r.quantity})
                                      <br />
                                      {r.changedByName ?? "Someone"} · {fmtDate(r.changedAt)}
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </div>
                            <div className="text-xs mt-3 text-center" style={{ color: "var(--muted)" }}>Click outside or “Edit” again to close.</div>
                          </div>
                        </details>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              {sum && (
                <tfoot>
                  <tr className="font-semibold" style={{ borderTop: "2px solid var(--border)" }}>
                    <td className="td" colSpan={5}>Total</td>
                    <td className="td text-right tabular-nums">{money(sum.planned, c)}</td>
                    <td className="td text-right tabular-nums">{money(sum.committed, c)}</td>
                    <td className="td text-right tabular-nums">{money(sum.actual, c)}</td>
                    <td className="td text-right tabular-nums" style={{ color: sum.remaining < 0 ? "var(--danger)" : undefined }}>{money(sum.remaining, c)}</td>
                    <td className="td" />
                    {canManage && <td className="td" />}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {canManage && lines.length > 0 && (
        <div>
          <SectionTitle>Convert currency</SectionTitle>
          <form action={convertBudgetCurrencyAction} className="card p-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="projectId" value={id} />
            <Field label="Exchange rate (multiply all amounts by)">
              <input type="number" step="0.0001" name="rate" required className="input" placeholder="e.g. 3800" style={{ width: 180 }} />
            </Field>
            <Field label="New currency (optional)">
              <select name="newCurrency" className="select" defaultValue="">
                <option value="">Keep {c}</option>
                {["UGX", "USD", "EUR", "GBP", "KES", "TZS", "RWF", "NGN", "ZAR"].map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
            <button className="btn" type="submit">Convert all lines</button>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              Use this when a budget was imported in a different currency — e.g. USD→UGX at 1 USD ≈ 3,800 UGX.
              Multiplies every line&apos;s unit cost and planned amount by the rate.
            </span>
          </form>
        </div>
      )}

      {canManage && (
        <div>
          <SectionTitle>Add budget line</SectionTitle>
          <form action={addBudgetLineAction} className="card p-4 grid sm:grid-cols-6 gap-3 items-end">
            <input type="hidden" name="projectId" value={id} />
            {bud && <input type="hidden" name="budgetId" value={bud.id} />}
            <Field label="Code"><input name="code" className="input" placeholder="BL-011" /></Field>
            <div className="sm:col-span-2"><Field label="Description"><input name="description" required className="input" placeholder="e.g. Field allowances" /></Field></div>
            <Field label="Unit"><input name="unit" className="input" placeholder="month" defaultValue="unit" /></Field>
            <Field label="Unit cost"><input type="number" step="0.01" name="unitCost" className="input" defaultValue={0} /></Field>
            <div className="flex gap-2">
              <Field label="Qty"><input type="number" step="0.01" name="quantity" className="input" defaultValue={1} /></Field>
              <button className="btn btn-primary self-end" type="submit">Add</button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
