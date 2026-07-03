import { requireProcOrg } from "./_guard";
import { isModuleEnabled } from "@/server/modules";
import { one } from "@/server/db";
import { PageHeader, SectionTitle, Stat, ToolCard } from "@/components/ui";
import type { IconName } from "@/components/icons";

export default async function ProcurementHome() {
  const { orgId, orgName } = await requireProcOrg();
  const showGov = await isModuleEnabled(orgId, "public_procurement");
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
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {([
          ["/procurement/requests", "list", "Purchase requests", "Raise & approve requests to buy."],
          ["/procurement/orders", "procurement", "Purchase orders", "Approved orders placed with vendors."],
          ["/procurement/bills", "invoice", "Vendor bills", "Payables raised from orders."],
          ["/procurement/vendors", "building", "Vendors", "Supplier directory & details."],
          ["/procurement/config", "modules", "Thresholds", "Quotation rules by purchase value."],
          ["/procurement/plan", "calendar", "Procurement plan", "Planned purchases by period vs budget."],
          ["/procurement/ethics", "compliance", "Ethics register", "Conflict-of-interest & gifts log."],
          ...(showGov ? ([["/procurement/tenders", "audit", "Tenders & bids", "Advertise, open, evaluate & award tenders."], ["/procurement/contracts", "grant", "Contracts", "Delivery, payments & provider performance."], ["/procurement/committees", "collab", "Committees", "Contracts, evaluation, bid opening & disposal committees."], ["/procurement/disposals", "inventory", "Disposal management", "Board of survey, committee review & disposal."]] as [string, IconName, string, string][]) : []),
        ] as [string, IconName, string, string][]).map(([href, icon, t, d]) => (
          <ToolCard key={href} href={href} icon={icon} title={t} desc={d} />
        ))}
      </div>
    </div>
  );
}
