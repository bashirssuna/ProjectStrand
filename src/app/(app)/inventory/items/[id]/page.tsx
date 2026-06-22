import Link from "next/link";
import { notFound } from "next/navigation";
import { requireInventoryOrg } from "../../_guard";
import { q } from "@/server/db";
import { getItem, itemMovements, listStores, isLow } from "@/server/services/inventory";
import { getUserOrg } from "@/server/services/accounts";
import { requireUser } from "@/server/auth";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { currencyOptions } from "@/lib/currencies";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { updateItemAction, recordMovementAction, deleteItemAction } from "@/app/actions";

const TYPES = ["consumable", "asset", "other"];

export default async function ItemDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const { orgId } = await requireInventoryOrg();
  const sp = await searchParams;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  const cur = org?.displayCurrency ?? org?.baseCurrency ?? "USD";

  const item = await getItem(orgId, id);
  if (!item) notFound();
  const [moves, stores] = await Promise.all([itemMovements(id), listStores(orgId)]);
  const low = isLow(item);
  const itemCur = item.currency ?? cur;

  // Change history (audit trail) for this item.
  const history = await q<{ action: string; actor: string | null; createdAt: string; before: string | null; after: string | null; meta: string | null }>(
    `SELECT a.action, a.created_at AS "createdAt", a.before, a.after, a.meta, u.name AS actor
     FROM audit_log a LEFT JOIN app_user u ON u.id=a.user_id
     WHERE a.entity='stock_item' AND a.entity_id=$1 ORDER BY a.created_at DESC`, [id]
  );
  const parse = (j: string | null): Record<string, unknown> | null => { if (!j) return null; try { const v = JSON.parse(j); return v && typeof v === "object" ? v as Record<string, unknown> : null; } catch { return null; } };
  const histRows = history.map((h) => {
    const before = parse(h.before), after = parse(h.after);
    const title = h.action === "create" ? "Created" : "Edited";
    const isEdit = title === "Edited" && !!before && !!after;
    return { title, actor: h.actor, createdAt: h.createdAt, before, after, isEdit };
  });

  return (
    <div className="max-w-4xl">
      <PageHeader title={`${item.code ? item.code + " — " : ""}${item.name}`} subtitle={`${label(item.itemType)}${item.category ? ` · ${item.category}` : ""}`}
        actions={<div className="flex gap-2">
          <form action={deleteItemAction} className="inline"><input type="hidden" name="itemId" value={item.id} /><ConfirmSubmit message="Delete this item and all its movements?"><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button></ConfirmSubmit></form>
          <Link href="/inventory" className="btn btn-sm">← Inventory</Link>
        </div>} />

      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Item created.</div>}
      {sp.saved && Number(sp.saved) > 0 && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved {sp.saved} change{sp.saved === "1" ? "" : "s"}.</div>}
      {sp.moved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Stock {sp.moved} recorded.</div>}
      {sp.err === "insufficient" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Not enough stock on hand for that issue/disposal — the quantity can&apos;t exceed the current balance. Use an adjustment if you need to correct the balance.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="On hand" value={`${item.balance} ${item.unit}`} tone={low ? "warn" : undefined} sub={low ? `reorder at ${item.reorderLevel}` : undefined} />
        <Stat label="Unit cost" value={money(item.unitCost, itemCur)} />
        <Stat label="Stock value" value={money(item.balance * item.unitCost, itemCur)} />
        <Stat label="Reorder level" value={item.reorderLevel ? `${item.reorderLevel} ${item.unit}` : "—"} />
      </div>

      {/* Record movement */}
      <div className="card p-4 mb-5">
        <SectionTitle>Record stock movement</SectionTitle>
        <form action={recordMovementAction} className="grid sm:grid-cols-4 gap-3 items-end">
          <input type="hidden" name="itemId" value={item.id} />
          <Field label="Type"><select name="kind" defaultValue="receipt" className="select"><option value="receipt">Receipt (in)</option><option value="issue">Issue (out)</option><option value="disposal">Disposal (out)</option><option value="adjustment">Adjustment (±)</option></select></Field>
          <Field label="Quantity"><input type="number" step="any" name="qty" required className="input" placeholder="e.g. 50" /></Field>
          <Field label="Store"><select name="storeId" className="select"><option value="">—</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          <Field label="Date"><input type="date" name="movementDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
          <Field label="Unit cost (receipts)"><input type="number" step="any" min={0} name="unitCost" className="input" placeholder="updates standard cost" /></Field>
          <Field label="Issued to / supplier"><input name="issuedTo" className="input" /></Field>
          <Field label="Reference"><input name="reference" className="input" placeholder="GRN / voucher no." /></Field>
          <div className="flex items-end"><button className="btn btn-primary w-full" type="submit">Record</button></div>
        </form>
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Receipts increase stock; issues and disposals reduce it. For an adjustment, enter a signed value (e.g. -3 to write down, 5 to write up).</p>
      </div>

      {/* Movement ledger */}
      <div className="card p-4 mb-5">
        <SectionTitle>Movement history</SectionTitle>
        {moves.length === 0 ? <Empty title="No movements yet" hint="Record a receipt to bring this item into stock." /> : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Date</th><th className="th text-left">Type</th><th className="th text-right">Qty</th><th className="th text-left">Store</th><th className="th text-left">Ref</th><th className="th text-left">To / from</th><th className="th text-left">By</th></tr></thead>
            <tbody>{moves.map((m) => (
              <tr key={m.id}>
                <td className="td whitespace-nowrap">{fmtDate(m.movementDate)}</td>
                <td className="td"><Badge tone={m.kind === "receipt" ? "ok" : m.kind === "adjustment" ? "info" : "warn"}>{label(m.kind)}</Badge></td>
                <td className="td text-right tabular-nums" style={{ color: m.qty < 0 ? "var(--danger)" : "var(--ok)" }}>{m.qty > 0 ? "+" : ""}{m.qty} {item.unit}</td>
                <td className="td">{m.storeName ?? "—"}</td>
                <td className="td">{m.reference ?? "—"}</td>
                <td className="td">{m.issuedTo ?? "—"}</td>
                <td className="td">{m.by ?? "—"}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>

      {/* Edit */}
      <div className="card p-4">
        <SectionTitle>Item settings</SectionTitle>
        <form action={updateItemAction} className="grid sm:grid-cols-3 gap-3">
          <input type="hidden" name="itemId" value={item.id} />
          <Field label="Code"><input name="code" defaultValue={item.code ?? ""} className="input" /></Field>
          <Field label="Name"><input name="name" required defaultValue={item.name} className="input" /></Field>
          <Field label="Type"><select name="itemType" defaultValue={item.itemType} className="select">{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Category"><input name="category" defaultValue={item.category ?? ""} className="input" /></Field>
          <Field label="Unit"><input name="unit" defaultValue={item.unit} className="input" /></Field>
          <Field label="Unit cost"><input type="number" step="any" min={0} name="unitCost" defaultValue={item.unitCost} className="input" /></Field>
          <Field label="Currency"><select name="currency" defaultValue={itemCur} className="select">{currencyOptions(itemCur).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Reorder level"><input type="number" step="any" min={0} name="reorderLevel" defaultValue={item.reorderLevel} className="input" /></Field>
          <Field label="Status"><select name="status" defaultValue={item.status} className="select"><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
          <div className="flex items-end"><button className="btn btn-sm btn-primary" type="submit">Save</button></div>
        </form>
      </div>

      {/* Change history (audit trail of item edits) */}
      <div className="card p-4 mt-5">
        <SectionTitle>Change history</SectionTitle>
        {histRows.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>No edits recorded yet.</p> : (
          <ol className="space-y-4">
            {histRows.map((h, i) => (
              <li key={i} className="relative pl-5">
                <span style={{ position: "absolute", left: 0, top: 4, width: 9, height: 9, borderRadius: "50%", background: h.title === "Created" ? "var(--brand)" : "var(--info)" }} />
                {i < histRows.length - 1 && <span style={{ position: "absolute", left: 4, top: 13, bottom: -16, width: 1, background: "var(--border)" }} />}
                <div className="text-sm font-medium">{h.title}</div>
                <div className="text-xs" style={{ color: "var(--muted)" }}>{fmtDateTime(h.createdAt)}{h.actor ? ` · ${h.actor}` : ""}</div>
                {h.isEdit && h.after ? (
                  <ul className="mt-1 space-y-0.5">
                    {Object.keys(h.after).map((k) => (
                      <li key={k} className="text-xs">
                        <span style={{ color: "var(--muted)" }}>{k}: </span>
                        <span style={{ textDecoration: "line-through", color: "var(--muted)" }}>{String((h.before as Record<string, unknown>)?.[k] ?? "—")}</span>
                        <span style={{ color: "var(--muted)" }}> → </span>
                        <span>{String((h.after as Record<string, unknown>)[k] ?? "—")}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
