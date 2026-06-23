import Link from "next/link";
import { requireProcOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Empty } from "@/components/ui";
import { addVendorAction } from "@/app/actions";
import { ExportMenu } from "@/components/export-menu";

export default async function VendorsPage({ searchParams }: { searchParams: Promise<{ created?: string; err?: string; imported?: string; skipped?: string }> }) {
  const { orgId } = await requireProcOrg();
  const sp = await searchParams;
  const vendors = await q<{ id: string; name: string; contactPerson: string | null; email: string | null; phone: string | null; taxId: string | null }>(
    `SELECT id, name, contact_person AS "contactPerson", email, phone, tax_id AS "taxId" FROM vendor WHERE org_id=$1 ORDER BY name`, [orgId]
  );
  return (
    <div className="max-w-4xl">
      <PageHeader title="Vendors" subtitle="Supplier directory" actions={<div className="flex flex-wrap gap-2 no-print"><Link href="/procurement/import/vendor" className="btn btn-sm">Import Excel</Link><Link href="/print/procurement/vendors" target="_blank" className="btn btn-sm">Print</Link><ExportMenu scope="vendors" /><Link href="/procurement" className="btn btn-sm">← Procurement</Link></div>} />
      {sp.imported && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Imported {sp.imported} vendor{sp.imported === "1" ? "" : "s"}{sp.skipped ? ` · ${sp.skipped} row${sp.skipped === "1" ? "" : "s"} skipped (no name)` : ""}.</div>}
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Vendor added.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Vendor name is required.</div>}
      <SectionTitle>Vendors</SectionTitle>
      {vendors.length === 0 ? <Empty title="No vendors yet" hint="Add your first supplier below." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Name</th><th className="th text-left">Contact</th><th className="th text-left">Email</th><th className="th text-left">Phone</th><th className="th text-left">Tax ID</th></tr></thead>
            <tbody>{vendors.map((v) => (<tr key={v.id}><td className="td">{v.name}</td><td className="td">{v.contactPerson ?? "—"}</td><td className="td">{v.email ?? "—"}</td><td className="td">{v.phone ?? "—"}</td><td className="td">{v.taxId ?? "—"}</td></tr>))}</tbody>
          </table>
        </div>
      )}
      <SectionTitle>Add a vendor</SectionTitle>
      <form action={addVendorAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <Field label="Name"><input name="name" required className="input" /></Field>
        <Field label="Contact person"><input name="contactPerson" className="input" /></Field>
        <Field label="Email"><input name="email" className="input" /></Field>
        <Field label="Phone"><input name="phone" className="input" /></Field>
        <Field label="Tax ID"><input name="taxId" className="input" /></Field>
        <Field label="Bank account"><input name="bankAccount" className="input" /></Field>
        <div className="sm:col-span-3"><Field label="Address"><input name="address" className="input" /></Field></div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Add vendor</button></div>
      </form>
    </div>
  );
}
