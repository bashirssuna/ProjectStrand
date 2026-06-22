import Link from "next/link";
import { requireInventoryOrg } from "../_guard";
import { PageHeader, SectionTitle, Field } from "@/components/ui";
import { createItemAction } from "@/app/actions";
import { label } from "@/lib/enums";

const TYPES = ["consumable", "asset", "other"];

export default async function NewItem() {
  await requireInventoryOrg();
  return (
    <div className="max-w-2xl">
      <PageHeader title="New stock item" subtitle="Add a consumable or asset to the catalogue" actions={<Link href="/inventory" className="btn btn-sm">← Inventory</Link>} />
      <form action={createItemAction} className="card p-4 space-y-4">
        <SectionTitle>Item details</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Code"><input name="code" className="input" placeholder="e.g. RG-001" /></Field>
          <Field label="Name"><input name="name" required className="input" placeholder="e.g. Nitrile gloves (box)" /></Field>
          <Field label="Type"><select name="itemType" defaultValue="consumable" className="select">{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Category"><input name="category" className="input" placeholder="e.g. Laboratory" /></Field>
          <Field label="Unit"><input name="unit" defaultValue="unit" className="input" placeholder="e.g. box, litre, piece" /></Field>
          <Field label="Unit cost"><input type="number" step="any" min={0} name="unitCost" defaultValue={0} className="input" /></Field>
          <Field label="Reorder level"><input type="number" step="any" min={0} name="reorderLevel" defaultValue={0} className="input" /></Field>
        </div>
        <p className="text-xs" style={{ color: "var(--muted)" }}>Mark capital equipment as <strong>Asset</strong> and supplies as <strong>Consumable</strong>. Set a reorder level above zero to get low-stock alerts.</p>
        <div className="flex gap-2"><button className="btn btn-primary" type="submit">Create item</button><Link href="/inventory" className="btn">Cancel</Link></div>
      </form>
    </div>
  );
}
