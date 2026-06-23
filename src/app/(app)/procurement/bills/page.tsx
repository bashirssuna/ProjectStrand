import Link from "next/link";
import { requireProcOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, StatusBadge, Empty } from "@/components/ui";
import { money, fmtDate, ccyTotal, groupByCcy } from "@/lib/format";
import { ExportMenu } from "@/components/export-menu";

export default async function BillsPage({ searchParams }: { searchParams: Promise<{ created?: string }> }) {
  const { orgId } = await requireProcOrg();
  const sp = await searchParams;
  const bills = await q<{ id: string; number: string; billDate: string; dueDate: string | null; vendor: string | null; poNumber: string | null; currency: string; total: number; amountPaid: number; status: string }>(
    `SELECT b.id, b.number, b.bill_date AS "billDate", b.due_date AS "dueDate", v.name AS vendor, po.number AS "poNumber",
            b.currency, b.total::float, b.amount_paid::float AS "amountPaid", b.status
     FROM vendor_bill b LEFT JOIN vendor v ON v.id=b.vendor_id LEFT JOIN purchase_order po ON po.id=b.po_id
     WHERE b.org_id=$1 ORDER BY b.created_at DESC LIMIT 50`, [orgId]
  );
  const outstanding = bills.filter((b) => b.status !== "paid" && b.status !== "void");
  const outstandingTotal = ccyTotal(groupByCcy(outstanding, (b) => b.total - b.amountPaid, (b) => b.currency, bills[0]?.currency ?? "USD"), bills[0]?.currency ?? "USD");

  return (
    <div className="max-w-5xl">
      <PageHeader title="Vendor bills" subtitle="Payables raised from purchase orders" actions={<div className="flex flex-wrap gap-2 no-print"><Link href="/print/procurement/bills" target="_blank" className="btn btn-sm">Print</Link><ExportMenu scope="bills" /><Link href="/procurement" className="btn btn-sm">← Procurement</Link></div>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Vendor bill raised.</div>}
      {bills.length === 0 ? <Empty title="No vendor bills yet" hint="Bills are raised from a received purchase order." /> : (
        <>
          <div className="card p-3 mb-4" style={{ maxWidth: 320 }}>
            <div className="label">Total outstanding payables</div>
            <div className="font-semibold tabular-nums">{outstandingTotal.value}</div>
            {outstandingTotal.mixed && <div className="text-xs mt-1 flex flex-wrap gap-x-4" style={{ color: "var(--muted)" }}>{outstandingTotal.parts.map(([c, v]) => <span key={c} className="tabular-nums">{money(v, c)}</span>)}</div>}
          </div>
          <SectionTitle>Bills</SectionTitle>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Bill</th><th className="th text-left">Vendor</th><th className="th text-left">PO</th><th className="th text-left">Date</th><th className="th text-left">Due</th><th className="th text-left">Status</th><th className="th text-right">Total</th></tr></thead>
              <tbody>
                {bills.map((b) => (
                  <tr key={b.id}>
                    <td className="td font-mono text-xs">{b.number}</td>
                    <td className="td">{b.vendor ?? "—"}</td>
                    <td className="td font-mono text-xs">{b.poNumber ?? "—"}</td>
                    <td className="td whitespace-nowrap">{fmtDate(b.billDate)}</td>
                    <td className="td whitespace-nowrap">{b.dueDate ? fmtDate(b.dueDate) : "—"}</td>
                    <td className="td"><StatusBadge status={b.status} /></td>
                    <td className="td text-right tabular-nums">{money(b.total, b.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>Paying bills and posting them to the ledger (debit expense, credit payables/cash) will be wired in when the Finance module is completed.</p>
        </>
      )}
    </div>
  );
}
