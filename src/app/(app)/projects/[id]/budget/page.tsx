import Link from "next/link";
import { getProjectAccess, canManageBudgetBulk } from "@/server/policy";
import { one, q } from "@/server/db";
import { budgetLineRollups, budgetSummary, STANDARD_BUDGET_CATEGORIES, budgetApprovalHistory, budgetReallocations, type LineRollup } from "@/server/services/budget";
import { addBudgetLineAction, convertBudgetCurrencyAction, updateBudgetLineAction, deleteBudgetLineAction, clearBudgetLinesAction, setupBudgetSectionsAction, submitBudgetAction, approveBudgetAction, rejectBudgetAction, reopenBudgetAction, reallocateBudgetAction } from "@/app/actions";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { CancelButton } from "@/components/cancel-button";
import { Stat, SectionTitle, Empty, ProgressBar, Field, Badge, StatusBadge } from "@/components/ui";
import { money, pct, num, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { blockStaff } from "../_staffblock";

export default async function BudgetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ bm?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  await blockStaff(id);
  const access = await getProjectAccess(id);
  const canManage = access.permissions.has("budget.manage");
  const canBulk = canManageBudgetBulk(access);
  const proj = await one<{ currency: string; status: string }>(`SELECT currency, status FROM project WHERE id=$1`, [id]);
  const c = proj?.currency ?? "USD";
  // Budget editing (add/edit/delete lines, clear all) is restricted to PI / Co-PI /
  // Finance / org admin. On a LIVE (active) project every change needs a reason.
  const isLive = proj?.status === "active";

  const bud = await one<{ id: string; name: string; kind: string; status: string }>(
    `SELECT id, name, kind, status FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [id]
  );
  const status = bud?.status ?? "draft";
  const editable = !bud || status !== "approved";
  const approvals = bud ? await budgetApprovalHistory(bud.id) : [];
  const reallocations = bud ? await budgetReallocations(bud.id) : [];
  const canEdit = canBulk && editable;
  const reasonField = isLive ? (
    <Field label="Reason for this change (required — project is live)"><input name="reason" required className="input" placeholder="Why is the budget being changed?" /></Field>
  ) : null;
  const lines = bud ? await budgetLineRollups(bud.id) : [];
  const sum = bud ? await budgetSummary(bud.id) : null;
  const cats = bud ? await q<{ id: string; name: string; costType: string }>(
    `SELECT id, name, cost_type AS "costType" FROM budget_category WHERE budget_id=$1`, [bud.id]
  ) : [];

  // change history per line
  const revs = await q<{ budgetLineId: string; code: string; description: string; unitCost: number; quantity: number; frequency: number; planned: number; action: string; changedByName: string | null; changedAt: string; }>(
    `SELECT budget_line_id AS "budgetLineId", code, description, unit_cost AS "unitCost",
            quantity, COALESCE(frequency,1) AS frequency, planned, action, changed_by_name AS "changedByName", changed_at AS "changedAt"
     FROM budget_line_revision WHERE project_id=$1 ORDER BY changed_at DESC`, [id]
  );
  const revsByLine = new Map<string, typeof revs>();
  for (const r of revs) { const arr = revsByLine.get(r.budgetLineId) ?? []; arr.push(r); revsByLine.set(r.budgetLineId, arr); }

  const byCat = new Map<string | null, LineRollup[]>();
  for (const l of lines) { const k = l.categoryId ?? null; const arr = byCat.get(k) ?? []; arr.push(l); byCat.set(k, arr); }
  const uncategorized = byCat.get(null) ?? [];
  const hasLines = (catId: string) => (byCat.get(catId)?.length ?? 0) > 0;

  // Section order + hygiene:
  //  • standard template order first, custom sections after, and every INDIRECT
  //    category always LAST (indirect costs come after all direct costs);
  //  • empty, non-standard categories are hidden — these are usually leftover
  //    near-duplicates (e.g. "Personnel Costs" vs the standard "Personnel / Per
  //    Diem"). Standard sections always show, and any category with lines shows.
  const stdOrder = STANDARD_BUDGET_CATEGORIES.map((x) => x.name.toLowerCase());
  const stdSet = new Set(stdOrder);
  const isIndirectCat = (cat: { name: string; costType: string }) => cat.costType === "indirect" || /indirect|overhead/i.test(cat.name);
  const catSortKey = (cat: { name: string; costType: string }) => {
    const base = stdOrder.indexOf(cat.name.toLowerCase());
    return (isIndirectCat(cat) ? 1000 : 0) + (base >= 0 ? base : 900);
  };
  const visibleCats = [...cats]
    .filter((cat) => stdSet.has(cat.name.toLowerCase()) || hasLines(cat.id))
    .sort((a, b) => catSortKey(a) - catSortKey(b));

  const sectionSum = (ls: LineRollup[]) => ({
    planned: ls.reduce((s, l) => s + l.planned, 0), committed: ls.reduce((s, l) => s + l.committed, 0),
    actual: ls.reduce((s, l) => s + l.actual, 0), remaining: ls.reduce((s, l) => s + l.remaining, 0),
  });
  const colCount = canEdit ? 11 : 10;

  // sections to render: visible categories (indirect last), then Uncategorised.
  const sections: { id: string | null; name: string; costType: string; lines: LineRollup[] }[] = [
    ...visibleCats.map((cat) => ({ id: cat.id, name: cat.name, costType: cat.costType, lines: byCat.get(cat.id) ?? [] })),
    ...(uncategorized.length ? [{ id: null, name: "Uncategorised", costType: "direct", lines: uncategorized }] : []),
  ];

  const editForm = (l: LineRollup) => (
    <details className="editor inline-block">
      <summary className="btn btn-sm inline-block">Edit</summary>
      <div className="editor-panel card p-4 text-left">
        <div className="font-medium mb-3">Edit budget line</div>
        <form action={updateBudgetLineAction} className="grid gap-2">
          <input type="hidden" name="projectId" value={id} />
          <input type="hidden" name="lineId" value={l.id} />
          <Field label="Section"><select name="categoryId" defaultValue={l.categoryId ?? ""} className="select">
            <option value="">— Uncategorised —</option>
            {visibleCats.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
          </select></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Code"><input name="code" defaultValue={l.code} className="input" /></Field>
            <Field label="Unit"><input name="unit" defaultValue={l.unit} className="input" /></Field>
          </div>
          <Field label="Description"><input name="description" defaultValue={l.description} className="input" /></Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Unit cost / rate"><input name="unitCost" type="number" step="any" defaultValue={l.unitCost} className="input" /></Field>
            <Field label="Qty / No."><input name="quantity" type="number" step="any" defaultValue={l.quantity} className="input" /></Field>
            <Field label="× Days / times"><input name="frequency" type="number" step="any" defaultValue={l.frequency} className="input" /></Field>
          </div>
          <Field label="Justification"><textarea name="justification" rows={2} defaultValue={l.justification ?? ""} className="textarea" placeholder="Why this cost is needed" /></Field>
          {reasonField}
          <div className="flex gap-2">
            <button className="btn btn-primary btn-sm" type="submit">Save changes</button>
            <CancelButton className="btn btn-sm">Cancel</CancelButton>
          </div>
        </form>
        <form action={deleteBudgetLineAction} className="mt-3 pt-3 grid gap-2" style={{ borderTop: "1px solid var(--border)" }}>
          <input type="hidden" name="projectId" value={id} />
          <input type="hidden" name="lineId" value={l.id} />
          {isLive && <Field label="Reason for deletion (required — project is live)"><input name="reason" required className="input" placeholder="Why delete this line?" /></Field>}
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
                  <span style={{ color: r.action === "deleted" ? "var(--danger)" : "var(--fg)" }}>{r.action === "deleted" ? "Removed" : "Was"}: {money(r.planned, c)}</span>{" "}
                  ({money(r.unitCost, c)} × {num(r.quantity)}{r.frequency !== 1 ? ` × ${num(r.frequency)}` : ""})<br />
                  {r.changedByName ?? "Someone"} · {fmtDate(r.changedAt)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </details>
  );

  const lineRow = (l: LineRollup) => (
    <tr key={l.id}>
      <td className="td font-mono text-xs">{l.code}</td>
      <td className="td">{l.description}
        {l.justification && <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{l.justification}</div>}
      </td>
      <td className="td text-right tabular-nums">{money(l.unitCost, c)}</td>
      <td className="td text-right tabular-nums">{num(l.quantity)}</td>
      <td className="td text-right tabular-nums" style={{ color: l.frequency === 1 ? "var(--muted)" : undefined }}>{num(l.frequency)}</td>
      <td className="td text-right tabular-nums font-medium">{money(l.planned, c)}</td>
      <td className="td text-right tabular-nums">{money(l.committed, c)}</td>
      <td className="td text-right tabular-nums">{money(l.actual, c)}</td>
      <td className="td text-right tabular-nums" style={{ color: l.remaining < 0 ? "var(--danger)" : undefined }}>{money(l.remaining, c)}</td>
      <td className="td"><ProgressBar value={l.burn} tone={l.burn > 100 ? "danger" : l.burn > 90 ? "warn" : "ok"} /></td>
      {canEdit && <td className="td text-right whitespace-nowrap">{editForm(l)}</td>}
    </tr>
  );

  return (
    <div className="space-y-7">
      {sp.bm && (
        <div className="card p-3 text-sm" style={{ color: ["insufficient", "badmove", "needreason"].includes(sp.bm) ? "var(--danger)" : "var(--ok)", borderColor: ["insufficient", "badmove", "needreason"].includes(sp.bm) ? "var(--danger)" : "var(--ok)" }}>
          {sp.bm === "needreason" && "This project is live — a reason is required for any budget change. Please try again and give a reason."}
          {sp.bm === "submitted" && "Budget submitted for approval."}
          {sp.bm === "approved" && "Budget approved and locked. Reopen it to make further changes."}
          {sp.bm === "rejected" && "Budget returned for revision."}
          {sp.bm === "reopened" && "Budget reopened — lines can be edited again."}
          {sp.bm === "reallocated" && "Funds reallocated between budget lines."}
          {sp.bm === "insufficient" && "Reallocation exceeds the available (uncommitted, unspent) balance on the source line."}
          {sp.bm === "badmove" && "Choose two different lines and a positive amount to reallocate."}
        </div>
      )}
      {sum && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <Stat label="Planned" value={money(sum.planned, c)} />
          <Stat label="Committed" value={money(sum.committed, c)} sub="reserved by approvals" />
          <Stat label="Spent" value={money(sum.actual, c)} />
          <Stat label="Remaining" value={money(sum.remaining, c)} tone={sum.remaining < 0 ? "danger" : "ok"} />
          <Stat label="Burn rate" value={pct(sum.burn)} tone={sum.burn > 90 ? "warn" : undefined} />
        </div>
      )}

      {bud && (
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: "var(--muted)" }}>Approval status</span>
              <StatusBadge status={status} />
            </div>
            {canManage && (
              <div className="flex items-center gap-2">
                {(status === "draft" || status === "rejected") && (
                  <form action={submitBudgetAction}><input type="hidden" name="projectId" value={id} /><input type="hidden" name="budgetId" value={bud.id} />
                    <button className="btn btn-sm btn-primary" type="submit">Submit for approval</button>
                  </form>
                )}
                {status === "submitted" && canBulk && (
                  <>
                    <form action={approveBudgetAction}><input type="hidden" name="projectId" value={id} /><input type="hidden" name="budgetId" value={bud.id} /><button className="btn btn-sm btn-primary" type="submit">Approve</button></form>
                    <form action={rejectBudgetAction}><input type="hidden" name="projectId" value={id} /><input type="hidden" name="budgetId" value={bud.id} /><ConfirmSubmit message="Return this budget for revision?" className="btn btn-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reject</ConfirmSubmit></form>
                  </>
                )}
                {status === "submitted" && !canBulk && <span className="text-xs" style={{ color: "var(--muted)" }}>Awaiting approval by PI / Finance.</span>}
                {status === "approved" && canBulk && (
                  <form action={reopenBudgetAction}><input type="hidden" name="projectId" value={id} /><input type="hidden" name="budgetId" value={bud.id} /><button className="btn btn-sm" type="submit">Reopen for revision</button></form>
                )}
              </div>
            )}
          </div>
          {!editable && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>This budget is approved and locked. Use <strong>reallocations</strong> below to move funds between lines, or reopen it to edit lines directly.</p>}
          {approvals.length > 0 && (
            <div className="mt-3 text-xs space-y-0.5" style={{ color: "var(--muted)" }}>
              {approvals.slice(0, 5).map((a, i) => (
                <div key={i}>{label(a.action)} by {a.actedByName ?? "—"} · {fmtDateTime(a.actedAt)}{a.note ? ` — ${a.note}` : ""}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div>
        <SectionTitle action={canEdit ? (
          <div className="flex items-center gap-2">
            {cats.length === 0 && (
              <form action={setupBudgetSectionsAction}><input type="hidden" name="projectId" value={id} />{bud && <input type="hidden" name="budgetId" value={bud.id} />}
                <button className="btn btn-sm btn-primary" type="submit">Set up standard sections</button>
              </form>
            )}
            {canBulk && lines.length > 0 && (
              <form action={clearBudgetLinesAction} className="flex items-center gap-2"><input type="hidden" name="projectId" value={id} />
                {isLive && <input name="reason" required placeholder="Reason (required)" className="input input-sm" style={{ width: 170 }} />}
                <ConfirmSubmit
                  message="Clear ALL budget lines? This permanently deletes every line along with its committed and spent records, and unlinks any requisitions and activities tied to them. This cannot be undone."
                  className="btn btn-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Clear all</ConfirmSubmit>
              </form>
            )}
            {canBulk && <Link href={`/projects/${id}/import`} className="btn btn-sm">Import from file</Link>}
          </div>
        ) : undefined}>
          Budget {bud && <span className="text-sm font-normal" style={{ color: "var(--muted)" }}>· {bud.name}</span>}
        </SectionTitle>

        {canEdit && cats.length === 0 && lines.length > 0 && (
          <p className="text-sm mb-3 card p-3" style={{ borderColor: "var(--brand)" }}>Click <b>Set up standard sections</b> to add Personnel, Travel, Equipment, etc. Then assign each line to a section using its <b>Edit</b> button.</p>
        )}

        {lines.length === 0 && cats.length === 0 ? (
          <Empty title="No budget yet" hint={canManage ? "Set up the standard sections above, then add lines — or import a budget spreadsheet." : "No budget lines recorded."} />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Code</th>
                <th className="th text-left">Description</th>
                <th className="th text-right">Unit cost</th>
                <th className="th text-right">Qty</th>
                <th className="th text-right">× Freq</th>
                <th className="th text-right">Planned</th>
                <th className="th text-right">Committed</th>
                <th className="th text-right">Spent</th>
                <th className="th text-right">Remaining</th>
                <th className="th text-left" style={{ width: 120 }}>Burn</th>
                {canEdit && <th className="th text-right">Edit</th>}
              </tr></thead>
              {sections.map((sec) => {
                const ss = sectionSum(sec.lines);
                return (
                  <tbody key={sec.id ?? "uncat"}>
                    <tr style={{ background: "var(--surface)" }}>
                      <td className="td font-semibold uppercase text-xs tracking-wide" colSpan={colCount}>
                        {sec.name}{sec.costType === "indirect" && <Badge tone="muted">indirect</Badge>}
                      </td>
                    </tr>
                    {sec.lines.length === 0 ? (
                      <tr><td className="td text-xs" style={{ color: "var(--muted)" }} colSpan={colCount}>No lines yet{canManage ? " — add one below and pick this section." : ""}</td></tr>
                    ) : sec.lines.map(lineRow)}
                    {sec.lines.length > 0 && (
                      <tr style={{ fontWeight: 600, borderTop: "1px solid var(--border)" }}>
                        <td className="td" colSpan={5}>Subtotal — {sec.name}</td>
                        <td className="td text-right tabular-nums">{money(ss.planned, c)}</td>
                        <td className="td text-right tabular-nums">{money(ss.committed, c)}</td>
                        <td className="td text-right tabular-nums">{money(ss.actual, c)}</td>
                        <td className="td text-right tabular-nums" style={{ color: ss.remaining < 0 ? "var(--danger)" : undefined }}>{money(ss.remaining, c)}</td>
                        <td className="td" />
                        {canEdit && <td className="td" />}
                      </tr>
                    )}
                  </tbody>
                );
              })}
              {sum && (
                <tfoot>
                  <tr className="font-semibold" style={{ borderTop: "2px solid var(--border)" }}>
                    <td className="td" colSpan={5}>TOTAL BUDGET</td>
                    <td className="td text-right tabular-nums">{money(sum.planned, c)}</td>
                    <td className="td text-right tabular-nums">{money(sum.committed, c)}</td>
                    <td className="td text-right tabular-nums">{money(sum.actual, c)}</td>
                    <td className="td text-right tabular-nums" style={{ color: sum.remaining < 0 ? "var(--danger)" : undefined }}>{money(sum.remaining, c)}</td>
                    <td className="td" />
                    {canEdit && <td className="td" />}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>

      {canEdit && (
        <div>
          <SectionTitle>Add budget line</SectionTitle>
          <form action={addBudgetLineAction} className="card p-4 grid sm:grid-cols-6 gap-3 items-end">
            <input type="hidden" name="projectId" value={id} />
            {bud && <input type="hidden" name="budgetId" value={bud.id} />}
            <div className="sm:col-span-2"><Field label="Section">
              <select name="categoryId" className="select w-full" defaultValue={visibleCats[0]?.id ?? ""}>
                <option value="">— Uncategorised —</option>
                {visibleCats.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
              </select>
            </Field></div>
            <Field label="Code"><input name="code" className="input" placeholder="BL-011" /></Field>
            <div className="sm:col-span-3"><Field label="Description"><input name="description" required className="input" placeholder="e.g. Research assistants" /></Field></div>
            <Field label="Unit"><input name="unit" className="input" placeholder="month" defaultValue="unit" /></Field>
            <Field label="Unit cost / rate"><input type="number" step="0.01" name="unitCost" className="input" defaultValue={0} /></Field>
            <Field label="Qty / No."><input type="number" step="0.01" name="quantity" className="input" defaultValue={1} /></Field>
            <Field label="× Days / times"><input type="number" step="0.01" name="frequency" className="input" defaultValue={1} /></Field>
            <div className="sm:col-span-5"><Field label="Justification (optional)"><input name="justification" className="input" placeholder="Why this cost is needed" /></Field></div>
            <button className="btn btn-primary self-end" type="submit">Add line</button>
            {isLive && <div className="sm:col-span-6"><Field label="Reason for adding this line (required — project is live)"><input name="reason" required className="input" placeholder="Why is this line being added to a live budget?" /></Field></div>}
          </form>
          <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Planned amount = unit cost / rate × qty × days/times. For a lump sum, leave qty and days at 1. Example (Personnel): 4 RAs × 50,000/day × 240 days.</p>
        </div>
      )}

      {canBulk && lines.length >= 2 && (
        <div>
          <SectionTitle>Reallocate funds between lines (virement)</SectionTitle>
          <form action={reallocateBudgetAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-end">
            <input type="hidden" name="projectId" value={id} />{bud && <input type="hidden" name="budgetId" value={bud.id} />}
            <div className="sm:col-span-2"><Field label="From line (source)"><select name="fromLineId" required className="select w-full">
              <option value="">— source —</option>
              {lines.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.description} — avail {money(l.remaining, c)}</option>)}
            </select></Field></div>
            <Field label={`Amount (${c})`}><input type="number" step="0.01" min="0" name="amount" required className="input" /></Field>
            <button className="btn btn-primary" type="submit">Reallocate</button>
            <div className="sm:col-span-2"><Field label="To line (destination)"><select name="toLineId" required className="select w-full">
              <option value="">— destination —</option>
              {lines.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.description}</option>)}
            </select></Field></div>
            <div className="sm:col-span-2"><Field label="Reason (optional)"><input name="reason" className="input" placeholder="e.g. shift savings from Travel to Equipment" /></Field></div>
          </form>
          <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Moves planned funds from one line to another, keeping the total budget unchanged. You can only move the <strong>available</strong> balance (planned minus committed and spent). Each reallocation is logged below and in each line&apos;s change history.</p>
          {reallocations.length > 0 && (
            <div className="card overflow-x-auto mt-3">
              <table className="w-full text-sm">
                <thead><tr><th className="th text-left">When</th><th className="th text-left">From → To</th><th className="th text-right">Amount</th><th className="th text-left">Reason</th><th className="th text-left">By</th></tr></thead>
                <tbody>{reallocations.map((r, i) => (
                  <tr key={i}><td className="td whitespace-nowrap">{fmtDate(r.createdAt)}</td><td className="td">{r.fromCode ?? "—"} → {r.toCode ?? "—"}</td><td className="td text-right tabular-nums">{money(r.amount, c)}</td><td className="td">{r.reason ?? ""}</td><td className="td">{r.createdByName ?? "—"}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {canEdit && lines.length > 0 && (
        <div>
          <SectionTitle>Convert project currency</SectionTitle>
          <form action={convertBudgetCurrencyAction} className="card p-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="projectId" value={id} />
            <Field label="Exchange rate (multiply all amounts by)">
              <input type="number" step="any" min="0" name="rate" required className="input" placeholder="e.g. 3650, or 0.000274" style={{ width: 200 }} />
            </Field>
            <Field label="New currency (optional)">
              <select name="newCurrency" className="select" defaultValue="">
                <option value="">Keep {c}</option>
                {["UGX", "USD", "EUR", "GBP", "KES", "TZS", "RWF", "NGN", "ZAR"].map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
            <button className="btn" type="submit">Convert whole project</button>
            <p className="text-xs basis-full" style={{ color: "var(--muted)" }}>
              Re-prices the <strong>entire project</strong> by this rate — budget, actual spending, commitments, requisitions, vouchers, invoices &amp; receipts, procurement, sub-awards, and the project&apos;s own ledger postings — so the finance &amp; accounts figures move too, not just the budget lines. Example: UGX→USD at 0.000274 (1 USD ≈ 3,650 UGX). Apply once — it multiplies, so running it again multiplies again. Institution-level ledger entries not tied to this project keep the base currency; change that under Finance → Currency &amp; FX rates.
            </p>
          </form>
        </div>
      )}
    </div>
  );
}
