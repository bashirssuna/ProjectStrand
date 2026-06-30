import Link from "next/link";
import { requireProcOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate, ccyTotal, groupByCcy } from "@/lib/format";
import { addPlanItemAction, updatePlanItemStatusAction, deletePlanItemAction } from "@/app/actions";

const STATUSES = ["planned", "requested", "procured", "cancelled"] as const;
const tone = (s: string) => s === "procured" ? "ok" : s === "requested" ? "info" : s === "cancelled" ? "muted" : "warn";

export default async function ProcurementPlanPage({ searchParams }: { searchParams: Promise<{ saved?: string; err?: string }> }) {
  const { orgId, orgName } = await requireProcOrg();
  const sp = await searchParams;

  const items = await q<{ id: string; period: string; description: string; category: string | null; quantity: number; estUnitCost: number; estTotal: number; currency: string; neededBy: string | null; department: string | null; status: string; projectCode: string | null }>(
    `SELECT pi.id, pi.period, pi.description, pi.category, pi.quantity::float, pi.est_unit_cost::float AS "estUnitCost",
            pi.est_total::float AS "estTotal", pi.currency, pi.needed_by AS "neededBy", pi.department, pi.status,
            p.code AS "projectCode"
     FROM procurement_plan_item pi LEFT JOIN project p ON p.id=pi.project_id
     WHERE pi.org_id=$1 ORDER BY pi.period DESC, pi.created_at`, [orgId]
  );
  const projects = await q<{ id: string; code: string }>(`SELECT id, code FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);

  // group by period
  const byPeriod = new Map<string, typeof items>();
  for (const it of items) { if (!byPeriod.has(it.period)) byPeriod.set(it.period, []); byPeriod.get(it.period)!.push(it); }
  const grandTotal = ccyTotal(groupByCcy(items.filter((i) => i.status !== "cancelled"), (i) => i.estTotal, (i) => i.currency, items[0]?.currency ?? "USD"), items[0]?.currency ?? "USD");
  const planCurrency = items[0]?.currency ?? "USD";

  return (
    <div className="max-w-5xl">
      <PageHeader title="Procurement plan" subtitle={`Planned purchases by period · ${orgName}`} actions={<Link href="/procurement" className="btn btn-sm">← Procurement</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.err === "fields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A period and a description are required.</div>}

      <p className="text-sm mb-5" style={{ color: "var(--muted)" }}>
        Consolidate departmental needs into a plan for each period and review it against the budget before purchases proceed.
        Planned values exclude cancelled lines.
      </p>

      {items.length === 0 ? <Empty title="No planned purchases yet" hint="Add the first line below." /> : (
        <div className="space-y-6 mb-6">
          {[...byPeriod.entries()].map(([period, list]) => {
            const subtotal = ccyTotal(groupByCcy(list.filter((i) => i.status !== "cancelled"), (i) => i.estTotal, (i) => i.currency, planCurrency), planCurrency);
            return (
              <div key={period}>
                <div className="flex items-center justify-between mb-1">
                  <SectionTitle>{period}</SectionTitle>
                  <span className="text-sm tabular-nums" style={{ color: "var(--muted)" }}>Subtotal {subtotal.value}</span>
                </div>
                <div className="card overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr>
                      <th className="th text-left">Item</th><th className="th text-left">Dept / project</th>
                      <th className="th text-right">Qty</th><th className="th text-right">Est. total</th>
                      <th className="th text-left">Needed by</th><th className="th text-left">Status</th><th className="th" />
                    </tr></thead>
                    <tbody>
                      {list.map((it) => (
                        <tr key={it.id}>
                          <td className="td">{it.description}{it.category ? <span className="text-xs block" style={{ color: "var(--muted)" }}>{it.category}</span> : null}</td>
                          <td className="td text-xs">{it.department ?? "—"}{it.projectCode ? ` · ${it.projectCode}` : ""}</td>
                          <td className="td text-right">{it.quantity}</td>
                          <td className="td text-right tabular-nums">{money(it.estTotal, it.currency)}</td>
                          <td className="td">{it.neededBy ? fmtDate(it.neededBy) : "—"}</td>
                          <td className="td"><Badge tone={tone(it.status)}>{it.status}</Badge></td>
                          <td className="td text-right whitespace-nowrap">
                            <form action={updatePlanItemStatusAction} className="inline-flex items-center gap-1">
                              <input type="hidden" name="itemId" value={it.id} />
                              <select name="status" defaultValue={it.status} className="select" style={{ padding: "2px 6px" }}>{STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}</select>
                              <button className="btn btn-sm" type="submit">Set</button>
                            </form>{" "}
                            <form action={deletePlanItemAction} className="inline"><input type="hidden" name="itemId" value={it.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>×</button></form>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })}
          <div className="text-right text-sm font-medium">Total planned (excl. cancelled): <span className="tabular-nums">{grandTotal.value}</span>
            {grandTotal.mixed && <span className="text-xs ml-2" style={{ color: "var(--muted)" }}>({grandTotal.parts.map(([c, v]) => money(v, c)).join(" · ")})</span>}
          </div>
        </div>
      )}

      <SectionTitle>Add a planned purchase</SectionTitle>
      <form action={addPlanItemAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-end">
        <Field label="Period"><input name="period" required className="input" placeholder="e.g. 2025-Q3" /></Field>
        <div className="sm:col-span-2"><Field label="Description"><input name="description" required className="input" placeholder="e.g. Field tablets" /></Field></div>
        <Field label="Category"><input name="category" className="input" placeholder="Equipment" /></Field>
        <Field label="Quantity"><input type="number" step="0.01" name="quantity" defaultValue={1} className="input" /></Field>
        <Field label="Est. unit cost"><input type="number" step="0.01" name="estUnitCost" className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue={planCurrency} className="input" /></Field>
        <Field label="Needed by"><input type="date" name="neededBy" className="input" /></Field>
        <Field label="Department"><input name="department" className="input" /></Field>
        <Field label="Project (optional)"><select name="projectId" className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></Field>
        <div className="sm:col-span-2 flex justify-end"><button className="btn btn-primary" type="submit">Add to plan</button></div>
      </form>
    </div>
  );
}
