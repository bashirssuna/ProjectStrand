import Link from "next/link";
import { requireProcOrg } from "./_guard";
import { one } from "@/server/db";
import { PageHeader, SectionTitle, Stat } from "@/components/ui";

export default async function ProcurementHome() {
  const { orgId, orgName } = await requireProcOrg();
  const prPending = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM purchase_request WHERE org_id=$1 AND status='submitted'`, [orgId]))?.c ?? 0;
  const poOpen = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM purchase_order WHERE org_id=$1 AND status IN ('open','partially_received')`, [orgId]))?.c ?? 0;
  const billsUnpaid = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM vendor_bill WHERE org_id=$1 AND status IN ('unpaid','part_paid')`, [orgId]))?.c ?? 0;
  return (
    <div>
      <PageHeader title="Procurement" subtitle={`Vendors, purchase requests, orders & bills for ${orgName}`} />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Requests pending" value={String(prPending)} tone={prPending ? "warn" : undefined} />
        <Stat label="Open orders" value={String(poOpen)} />
        <Stat label="Unpaid bills" value={String(billsUnpaid)} tone={billsUnpaid ? "warn" : undefined} />
        <Stat label="Module" value="Procurement" sub="institution-level" />
      </div>
      <SectionTitle>Procurement tools</SectionTitle>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          ["/procurement/requests", "Purchase requests", "Raise & approve requests to buy."],
          ["/procurement/orders/", "Purchase orders", "Approved orders placed with vendors."],
          ["/procurement/bills", "Vendor bills", "Payables raised from orders."],
          ["/procurement/vendors", "Vendors", "Supplier directory & details."],
          ["/procurement/config", "Thresholds", "Quotation rules by purchase value."],
        ].map(([href, t, d]) => (
          <Link key={href} href={href === "/procurement/orders/" ? "/procurement/requests" : href} className="card p-4 hover:border-[var(--brand)]" style={{ display: "block" }}>
            <div className="font-display font-semibold">{t}</div>
            <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>{d}</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
