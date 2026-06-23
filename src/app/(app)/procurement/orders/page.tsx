import Link from "next/link";
import { requireProcOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, StatusBadge, Empty, Stat } from "@/components/ui";
import { money, fmtDate, ccyTotal, groupByCcy } from "@/lib/format";
import { label } from "@/lib/enums";
import { ExportMenu } from "@/components/export-menu";

const STATUSES = ["open", "partially_received", "received", "billed", "cancelled"];

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; search?: string }> }) {
  const { orgId } = await requireProcOrg();
  const sp = await searchParams;
  const where: string[] = ["po.org_id=$1"];
  const params: unknown[] = [orgId];
  let n = 2;
  if (sp.status) { where.push(`po.status=$${n}`); params.push(sp.status); n++; }
  if (sp.search) { where.push(`(po.number ILIKE $${n} OR v.name ILIKE $${n})`); params.push(`%${sp.search}%`); n++; }

  const orders = await q<{ id: string; number: string; vendor: string | null; projectCode: string | null; orderDate: string; status: string; currency: string; total: number; billed: boolean }>(
    `SELECT po.id, po.number, v.name AS vendor, p.code AS "projectCode", po.order_date AS "orderDate", po.status, po.currency, po.total::float8 AS total,
            EXISTS(SELECT 1 FROM vendor_bill b WHERE b.po_id=po.id) AS billed
     FROM purchase_order po LEFT JOIN vendor v ON v.id=po.vendor_id LEFT JOIN project p ON p.id=po.project_id
     WHERE ${where.join(" AND ")} ORDER BY po.created_at DESC LIMIT 500`, params
  );
  const all = await q<{ status: string; currency: string; total: number }>(`SELECT status, currency, total::float8 AS total FROM purchase_order WHERE org_id=$1`, [orgId]);
  const open = all.filter((o) => o.status === "open" || o.status === "partially_received").length;
  const received = all.filter((o) => o.status === "received").length;
  const totalValue = ccyTotal(groupByCcy(all.filter((o) => o.status !== "cancelled"), (o) => o.total, (o) => o.currency), "USD");

  return (
    <div className="max-w-5xl">
      <PageHeader title="Purchase orders" subtitle="Orders placed with vendors" actions={<div className="flex flex-wrap gap-2 no-print"><Link href="/print/procurement/orders" target="_blank" className="btn btn-sm">Print</Link><ExportMenu scope="orders" /><Link href="/procurement" className="btn btn-sm">← Procurement</Link></div>} />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Orders" value={String(all.length)} />
        <Stat label="Open" value={String(open)} tone={open ? "warn" : undefined} />
        <Stat label="Received" value={String(received)} />
        <Stat label="Total value" value={totalValue.value} sub={totalValue.mixed ? "multiple currencies" : undefined} />
      </div>

      {totalValue.mixed && (
        <div className="card p-3 mb-5 text-sm flex flex-wrap gap-x-5 gap-y-1">
          <span style={{ color: "var(--muted)" }}>Order value by currency:</span>
          {totalValue.parts.map(([c, v]) => <span key={c} className="tabular-nums">{money(v, c)}</span>)}
        </div>
      )}

      <form className="card p-4 mb-5 grid sm:grid-cols-3 gap-3 items-end">
        <div><Field label="Search"><input name="search" defaultValue={sp.search ?? ""} className="input" placeholder="PO number or vendor" /></Field></div>
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select"><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <div className="flex gap-2"><button className="btn btn-sm btn-primary" type="submit">Apply</button><Link href="/procurement/orders" className="btn btn-sm">Reset</Link></div>
      </form>

      {orders.length === 0 ? (
        <Empty title="No purchase orders yet" hint="Orders are created from approved purchase requests. Approve a request, then convert it to an order." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">PO</th><th className="th text-left">Vendor</th><th className="th text-left">Project</th><th className="th text-left">Date</th><th className="th text-left">Status</th><th className="th text-right">Total</th><th className="th" /></tr></thead>
            <tbody>
              {orders.map((o) => (
                <tr key={o.id}>
                  <td className="td font-mono text-xs">{o.number}</td>
                  <td className="td">{o.vendor ?? "—"}</td>
                  <td className="td">{o.projectCode ?? "—"}</td>
                  <td className="td whitespace-nowrap">{fmtDate(o.orderDate)}</td>
                  <td className="td"><StatusBadge status={o.status} /></td>
                  <td className="td text-right tabular-nums">{money(o.total, o.currency)}</td>
                  <td className="td text-right"><Link href={`/procurement/orders/${o.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
