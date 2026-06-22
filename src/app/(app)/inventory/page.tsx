import Link from "next/link";
import { requireInventoryOrg } from "./_guard";
import { listItems, listStores, isLow } from "@/server/services/inventory";
import { getUserOrg } from "@/server/services/accounts";
import { requireUser } from "@/server/auth";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { money } from "@/lib/format";
import { label } from "@/lib/enums";
import { createStoreAction } from "@/app/actions";

const TYPES = ["consumable", "asset", "other"];

export default async function Inventory({ searchParams }: { searchParams: Promise<{ search?: string; itemType?: string; added?: string; deleted?: string }> }) {
  const { orgId, orgName } = await requireInventoryOrg();
  const sp = await searchParams;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  const cur = org?.displayCurrency ?? org?.baseCurrency ?? "USD";

  const [items, stores] = await Promise.all([
    listItems(orgId, { search: sp.search, itemType: sp.itemType, status: "active" }),
    listStores(orgId),
  ]);
  const low = items.filter(isLow);
  const valueByCcy: Record<string, number> = {};
  for (const i of items) { const c = i.currency ?? cur; valueByCcy[c] = (valueByCcy[c] ?? 0) + i.balance * i.unitCost; }
  const ccyKeys = Object.keys(valueByCcy).sort();
  const valueStat = ccyKeys.length === 0 ? money(0, cur) : ccyKeys.length === 1 ? money(valueByCcy[ccyKeys[0]], ccyKeys[0]) : `${ccyKeys.length} currencies`;

  return (
    <div>
      <PageHeader title="Inventory & stores" subtitle={`Stock control for ${orgName}`} actions={<Link href="/inventory/new" className="btn btn-sm btn-primary">+ New item</Link>} />
      {sp.added === "store" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Store added.</div>}
      {sp.deleted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>Item deleted.</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="Stock items" value={String(items.length)} />
        <Stat label="Low stock" value={String(low.length)} tone={low.length ? "warn" : undefined} />
        <Stat label="Stock value" value={valueStat} sub={ccyKeys.length > 1 ? "multiple currencies" : undefined} />
        <Stat label="Stores" value={String(stores.length)} />
      </div>

      {ccyKeys.length > 1 && (
        <div className="card p-3 mb-5 text-sm flex flex-wrap gap-x-5 gap-y-1">
          <span style={{ color: "var(--muted)" }}>Stock value by currency:</span>
          {ccyKeys.map((c) => <span key={c} className="tabular-nums">{money(valueByCcy[c], c)}</span>)}
        </div>
      )}

      {low.length > 0 && (
        <div className="card p-4 mb-5" style={{ borderColor: "var(--warn)" }}>
          <div className="text-sm font-medium mb-2" style={{ color: "var(--warn)" }}>⚠ Reorder needed ({low.length})</div>
          <div className="space-y-1">
            {low.slice(0, 8).map((i) => (
              <div key={i.id} className="text-sm flex justify-between gap-2">
                <Link href={`/inventory/items/${i.id}`} className="hover:underline">{i.name}</Link>
                <span className="tabular-nums whitespace-nowrap" style={{ color: "var(--warn)" }}>{i.balance} {i.unit} · reorder at {i.reorderLevel}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <form className="card p-4 mb-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
        <div className="lg:col-span-2"><Field label="Search items"><input name="search" defaultValue={sp.search ?? ""} className="input" placeholder="Name, code or category" /></Field></div>
        <Field label="Type"><select name="itemType" defaultValue={sp.itemType ?? ""} className="select"><option value="">All</option>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
        <div className="flex gap-2"><button className="btn btn-sm btn-primary" type="submit">Apply</button><Link href="/inventory" className="btn btn-sm">Reset</Link></div>
      </form>

      {items.length === 0 ? (
        <Empty title="No stock items yet" hint="Add consumables and assets, then record receipts and issues to track balances." />
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Item</th><th className="th text-left">Type</th><th className="th text-right">Balance</th>
              <th className="th text-right">Reorder</th><th className="th text-right">Unit cost</th><th className="th text-right">Value</th><th className="th" />
            </tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="td"><Link href={`/inventory/items/${i.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{i.code ? <span className="font-mono text-xs mr-1">{i.code}</span> : null}{i.name}</Link></td>
                  <td className="td">{label(i.itemType)}</td>
                  <td className="td text-right tabular-nums">{i.balance} {i.unit}{isLow(i) && <Badge tone="warn">low</Badge>}</td>
                  <td className="td text-right tabular-nums">{i.reorderLevel || "—"}</td>
                  <td className="td text-right tabular-nums">{money(i.unitCost, i.currency ?? cur)}</td>
                  <td className="td text-right tabular-nums">{money(i.balance * i.unitCost, i.currency ?? cur)}</td>
                  <td className="td text-right"><Link href={`/inventory/items/${i.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-4 max-w-2xl">
        <SectionTitle>Stores</SectionTitle>
        {stores.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">{stores.map((s) => <Badge key={s.id} tone={s.status === "active" ? "ok" : "muted"}>{s.name}{s.location ? ` · ${s.location}` : ""}</Badge>)}</div>
        )}
        <form action={createStoreAction} className="grid sm:grid-cols-3 gap-2 items-end">
          <Field label="Store name"><input name="name" required className="input" placeholder="e.g. Main Store" /></Field>
          <Field label="Location"><input name="location" className="input" /></Field>
          <div><button className="btn btn-sm btn-primary" type="submit">Add store</button></div>
        </form>
      </div>
    </div>
  );
}
