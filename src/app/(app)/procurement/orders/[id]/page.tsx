import Link from "next/link";
import { requireProcOrg } from "../../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, StatusBadge, Badge, Empty } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { SignField } from "@/components/sign-field";
import { isModuleEnabled } from "@/server/modules";
import { createGRNAction, createBillAction, authorisePOAction, postReceivedItemAction } from "@/app/actions";

export default async function PODetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ grn?: string; err?: string; authorised?: string; posted?: string }> }) {
  const { id } = await params;
  const { orgId } = await requireProcOrg();
  const sp = await searchParams;
  const po = await one<{ id: string; number: string; orderDate: string; currency: string; total: number; status: string; vendor: string | null; project: string | null; lineCode: string | null; lineDesc: string | null; authorisedByName: string | null; authorisedSignature: string | null; authorisedAt: string | null }>(
    `SELECT po.id, po.number, po.order_date AS "orderDate", po.currency, po.total::float, po.status,
            v.name AS vendor, p.code AS project, bl.code AS "lineCode", bl.description AS "lineDesc",
            po.authorised_by_name AS "authorisedByName", po.authorised_signature AS "authorisedSignature", po.authorised_at AS "authorisedAt"
     FROM purchase_order po LEFT JOIN vendor v ON v.id=po.vendor_id LEFT JOIN project p ON p.id=po.project_id LEFT JOIN budget_line bl ON bl.id=po.budget_line_id
     WHERE po.id=$1 AND po.org_id=$2`, [id, orgId]
  );
  if (!po) return <Empty title="Purchase order not found" hint="It may have been removed." />;
  const items = await q<{ id: string; description: string; quantity: number; unit: string | null; unitCost: number; amount: number; qtyReceived: number; postedQty: number }>(
    `SELECT id, description, quantity::float, unit, unit_cost::float AS "unitCost", amount::float, qty_received::float AS "qtyReceived", posted_qty::float AS "postedQty" FROM purchase_order_item WHERE po_id=$1`, [id]
  );
  const storesOn = await isModuleEnabled(orgId, "stores");
  const stockItems = storesOn ? await q<{ id: string; name: string }>(`SELECT id, name FROM stock_item WHERE org_id=$1 AND status='active' ORDER BY name`, [orgId]) : [];
  const stores = storesOn ? await q<{ id: string; name: string }>(`SELECT id, name FROM store WHERE org_id=$1 AND status='active' ORDER BY name`, [orgId]) : [];
  const grns = await q<{ id: string; number: string; receivedDate: string; receivedByName: string | null }>(
    `SELECT id, number, received_date AS "receivedDate", received_by_name AS "receivedByName" FROM goods_received_note WHERE po_id=$1 ORDER BY received_date`, [id]
  );
  const incomeAccts = await q<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='expense' AND is_active ORDER BY code`, [orgId]);
  const fullyReceived = items.every((i) => i.qtyReceived >= i.quantity);
  const existingBill = await one<{ id: string; number: string }>(`SELECT id, number FROM vendor_bill WHERE po_id=$1 LIMIT 1`, [id]);

  return (
    <div className="max-w-4xl">
      <PageHeader title={`Purchase order ${po.number}`} subtitle={`${po.vendor ?? "—"}${po.project ? ` · ${po.project}` : ""}${po.lineCode ? ` · line ${po.lineCode}` : ""}`} actions={<Link href="/procurement/orders" className="btn btn-sm">← Orders</Link>} />
      {sp.grn && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Goods received note recorded.</div>}
      {sp.authorised && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Order authorised and signed.</div>}
      {sp.posted === "stores" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Received goods posted to stores.</div>}
      {sp.posted === "asset" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Received goods registered in the asset register.</div>}
      {sp.err === "stores_off" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>The Inventory &amp; stores module is turned off for this organisation.</div>}
      {sp.err === "noqty" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter at least one received quantity.</div>}
      {sp.err && sp.err !== "noqty" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.err)}</div>}

      <div className="card p-4 mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2"><StatusBadge status={po.status} /><span className="text-sm" style={{ color: "var(--muted)" }}>Ordered {fmtDate(po.orderDate)}</span></div>
        <div className="text-xl font-semibold tabular-nums">{money(po.total, po.currency)}</div>
      </div>

      {/* Authorising signature — sign the order before it is issued to the vendor */}
      <SectionTitle>Authorisation</SectionTitle>
      {po.authorisedSignature || po.authorisedByName ? (
        <div className="card p-4 mb-6">
          <div className="text-sm">Authorised by <strong>{po.authorisedByName ?? "—"}</strong>{po.authorisedAt ? ` · ${fmtDateTime(po.authorisedAt)}` : ""}</div>
          {po.authorisedSignature && <img src={po.authorisedSignature} alt="authorising signature" style={{ height: 50, marginTop: 8 }} />}
        </div>
      ) : po.status === "cancelled" ? null : (
        <form action={authorisePOAction} className="card p-4 mb-6">
          <input type="hidden" name="poId" value={po.id} />
          <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>An authorising officer signs the order before it is sent to the vendor. Draw or type your signature, then authorise.</p>
          <SignField name="sig" />
          <div className="flex justify-end mt-2"><button className="btn btn-sm btn-primary" type="submit">Authorise &amp; sign order</button></div>
        </form>
      )}

      <SectionTitle>Order items</SectionTitle>
      <div className="card overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <thead><tr><th className="th text-left">Description</th><th className="th text-right">Qty</th><th className="th text-right">Unit cost</th><th className="th text-right">Amount</th><th className="th text-right">Received</th></tr></thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td className="td">{i.description}</td>
                <td className="td text-right tabular-nums">{i.quantity}{i.unit ? ` ${i.unit}` : ""}</td>
                <td className="td text-right tabular-nums">{money(i.unitCost, po.currency)}</td>
                <td className="td text-right tabular-nums">{money(i.amount, po.currency)}</td>
                <td className="td text-right tabular-nums">{i.qtyReceived >= i.quantity ? <Badge tone="ok">{i.qtyReceived}</Badge> : <span>{i.qtyReceived} / {i.quantity}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* GRN */}
      {po.status !== "received" && po.status !== "billed" && po.status !== "cancelled" && (
        <>
          <SectionTitle>Record a goods received note</SectionTitle>
          <form action={createGRNAction} className="card p-4 mb-6">
            <input type="hidden" name="poId" value={po.id} />
            <div className="mb-3" style={{ maxWidth: 220 }}><Field label="Received date"><input type="date" name="receivedDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field></div>
            <table className="w-full text-sm mb-3">
              <thead><tr><th className="th text-left">Item</th><th className="th text-right">Outstanding</th><th className="th text-right">Receiving now</th></tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td className="td">{i.description}</td>
                    <td className="td text-right tabular-nums">{Math.max(0, i.quantity - i.qtyReceived)}</td>
                    <td className="td text-right"><input type="number" step="0.01" min={0} max={Math.max(0, i.quantity - i.qtyReceived)} name={`qty_${i.id}`} defaultValue={0} className="input" style={{ width: 100, textAlign: "right" }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex justify-end"><button className="btn btn-primary" type="submit">Record GRN</button></div>
          </form>
        </>
      )}

      {grns.length > 0 && (
        <>
          <SectionTitle>Goods received notes</SectionTitle>
          <div className="card overflow-x-auto mb-6">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">GRN</th><th className="th text-left">Date</th><th className="th text-left">Received by</th></tr></thead>
              <tbody>{grns.map((g) => (<tr key={g.id}><td className="td font-mono text-xs">{g.number}</td><td className="td">{fmtDate(g.receivedDate)}</td><td className="td">{g.receivedByName ?? "—"}</td></tr>))}</tbody>
            </table>
          </div>
        </>
      )}

      {/* Post received items to stores / assets */}
      {items.some((i) => i.qtyReceived - i.postedQty > 0) && (
        <>
          <SectionTitle>Post received items to stores / assets</SectionTitle>
          <div className="card p-4 mb-6">
            <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Push received goods into the inventory ledger or the asset register. Posted quantities won&apos;t be posted again.{!storesOn && " (Enable the Inventory & stores module to post to stores.)"}</p>
            <div className="space-y-1">
              {items.filter((i) => i.qtyReceived - i.postedQty > 0).map((i) => {
                const toPost = i.qtyReceived - i.postedQty;
                return (
                  <div key={i.id} className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
                    <div className="text-sm font-medium">{i.description} <span style={{ color: "var(--muted)" }}>· {toPost} {i.unit ?? "unit"} to post · {money(i.unitCost, po.currency)}/unit</span></div>
                    <div className="flex flex-wrap gap-5 mt-1">
                      {storesOn && (
                        <details>
                          <summary className="text-xs cursor-pointer hover:underline" style={{ color: "var(--brand)" }}>→ Post to stores</summary>
                          <form action={postReceivedItemAction} className="grid sm:grid-cols-4 gap-2 items-end mt-2" style={{ minWidth: 340 }}>
                            <input type="hidden" name="poItemId" value={i.id} /><input type="hidden" name="destination" value="stores" />
                            <Field label="Existing item"><select name="stockItemId" className="select"><option value="">— new —</option>{stockItems.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
                            <Field label="…or new item"><input name="newItemName" defaultValue={i.description} className="input" /></Field>
                            <Field label="Type"><select name="itemType" defaultValue="consumable" className="select"><option value="consumable">Consumable</option><option value="asset">Asset</option><option value="other">Other</option></select></Field>
                            <Field label="Store"><select name="storeId" className="select"><option value="">—</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
                            <div className="sm:col-span-4"><button className="btn btn-sm btn-primary" type="submit">Post to stores</button></div>
                          </form>
                        </details>
                      )}
                      <details>
                        <summary className="text-xs cursor-pointer hover:underline" style={{ color: "var(--brand)" }}>→ Register as asset</summary>
                        <form action={postReceivedItemAction} className="grid sm:grid-cols-3 gap-2 items-end mt-2" style={{ minWidth: 340 }}>
                          <input type="hidden" name="poItemId" value={i.id} /><input type="hidden" name="destination" value="asset" />
                          <Field label="Asset name"><input name="assetName" defaultValue={i.description} className="input" /></Field>
                          <Field label="Category"><input name="category" className="input" placeholder="e.g. IT equipment" /></Field>
                          <div><button className="btn btn-sm btn-primary" type="submit">Register asset</button></div>
                        </form>
                      </details>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* Bill */}
      <SectionTitle>Vendor bill</SectionTitle>
      {existingBill ? (
        <div className="card p-4"><span className="text-sm">Bill <span className="font-mono">{existingBill.number}</span> has been raised for this order. </span><Link href="/procurement/bills" className="btn btn-sm">View bills</Link></div>
      ) : fullyReceived || po.status === "partially_received" ? (
        <form action={createBillAction} className="card p-4 flex flex-wrap items-end gap-3">
          <input type="hidden" name="poId" value={po.id} />
          <Field label="Due date"><input type="date" name="dueDate" className="input" /></Field>
          <Field label="Expense account (optional)"><select name="expenseAccountId" className="select"><option value="">— none —</option>{incomeAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
          <button className="btn btn-primary" type="submit">Raise vendor bill</button>
        </form>
      ) : (
        <p className="text-sm" style={{ color: "var(--muted)" }}>Receive goods against this order before raising a bill.</p>
      )}
    </div>
  );
}
