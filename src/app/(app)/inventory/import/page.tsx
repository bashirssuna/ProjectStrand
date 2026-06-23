import Link from "next/link";
import { requireInventoryOrg } from "../_guard";
import { getInventoryImport, INVENTORY_IMPORT_FIELDS } from "@/server/services/inventory";
import { PageHeader, SectionTitle, Field, Empty, Badge } from "@/components/ui";
import { importInventoryUploadAction, confirmInventoryImportAction, cancelInventoryImportAction } from "@/app/actions";

const ERRORS: Record<string, string> = {
  nofile: "Choose a spreadsheet file to upload.",
  parse: "That file could not be read as a spreadsheet. Use .xlsx, .xls or .csv.",
  empty: "The file needs a header row and at least one data row.",
  name: "Map the Name column before importing — every item needs a name.",
};

export default async function InventoryImportPage({ searchParams }: { searchParams: Promise<{ job?: string; err?: string; cancelled?: string }> }) {
  const { orgId, orgName } = await requireInventoryOrg();
  const sp = await searchParams;
  const imp = sp.job ? await getInventoryImport(orgId, sp.job) : null;

  return (
    <div className="max-w-4xl">
      <PageHeader title="Import inventory from Excel" subtitle={`Bulk-add stock items & assets for ${orgName}`} actions={<Link href="/inventory" className="btn btn-sm">← Inventory</Link>} />
      {sp.err && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{ERRORS[sp.err] ?? "Something went wrong."}</div>}
      {sp.cancelled && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--muted)" }}>Import cancelled.</div>}

      {!imp && (
        <>
          <form action={importInventoryUploadAction} className="card p-4 mb-5">
            <SectionTitle>Upload a spreadsheet</SectionTitle>
            <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
              Upload your existing asset or stock list as <strong>.xlsx</strong>, <strong>.xls</strong> or <strong>.csv</strong>. The first row should be column headings.
              Columns are matched automatically (you can correct the mapping on the next screen) and nothing is saved until you confirm.
            </p>
            <Field label="Spreadsheet file"><input type="file" name="file" accept=".xlsx,.xls,.csv" required className="input" /></Field>
            <div className="mt-3"><button className="btn btn-primary" type="submit">Upload &amp; preview</button></div>
          </form>

          <div className="card p-4">
            <SectionTitle>Not sure of the format?</SectionTitle>
            <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
              Download a template, fill in your items, and upload it back. Recognised columns include: code / asset tag, name, category,
              type, unit, opening quantity, reorder level, unit cost and currency. Any extra columns are ignored.
            </p>
            <div className="flex flex-wrap gap-2">
              <a href="/api/export/inventory-template?format=xlsx" className="btn btn-sm">Template (.xlsx)</a>
              <a href="/api/export/inventory-template?format=csv" className="btn btn-sm">Template (.csv)</a>
            </div>
          </div>
        </>
      )}

      {imp && imp.status !== "preview" && (
        <div className="card p-4">
          <p className="text-sm">
            {imp.status === "applied"
              ? `This import has already been applied (${imp.createdCount} item${imp.createdCount === 1 ? "" : "s"} created).`
              : "This import was cancelled."}
          </p>
          <div className="mt-3 flex gap-2">
            <Link href="/inventory" className="btn btn-sm btn-primary">Go to inventory</Link>
            <Link href="/inventory/import" className="btn btn-sm">New import</Link>
          </div>
        </div>
      )}

      {imp && imp.status === "preview" && (() => {
        const colOptions = imp.header.map((h, i) => ({ i, label: `${String(h || "").trim() || `Column ${i + 1}`}` }));
        const preview = imp.rows.slice(0, 12);
        return (
          <form action={confirmInventoryImportAction}>
            <input type="hidden" name="importId" value={imp.id} />
            <div className="card p-4 mb-5">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                <SectionTitle>Map columns</SectionTitle>
                <Badge tone="info">{imp.fileName}</Badge>
              </div>
              <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
                Confirm which spreadsheet column feeds each field. <strong>Name</strong> is required; rows without a name are skipped.
                An <strong>Opening quantity</strong> records a starting stock receipt. Unmapped fields are left blank.
              </p>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {INVENTORY_IMPORT_FIELDS.map((f) => (
                  <Field key={f.key} label={f.required ? `${f.label} *` : f.label}>
                    <select name={`map_${f.key}`} defaultValue={String(imp.mapping[f.key] ?? -1)} className="select">
                      <option value="-1">— not mapped —</option>
                      {colOptions.map((c) => <option key={c.i} value={c.i}>{c.label}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
            </div>

            <div className="card overflow-x-auto mb-5">
              <div className="px-4 pt-3 text-xs" style={{ color: "var(--muted)" }}>
                Preview — first {preview.length} of {imp.rows.length} row{imp.rows.length === 1 ? "" : "s"}
              </div>
              <table className="w-full text-sm">
                <thead><tr>{imp.header.map((h, i) => <th key={i} className="th text-left whitespace-nowrap">{String(h || "").trim() || `Col ${i + 1}`}</th>)}</tr></thead>
                <tbody>
                  {preview.map((r, ri) => (
                    <tr key={ri}>{imp.header.map((_, ci) => <td key={ci} className="td whitespace-nowrap">{String(r[ci] ?? "")}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" type="submit">Import {imp.rows.length} row{imp.rows.length === 1 ? "" : "s"}</button>
              <button className="btn" type="submit" formAction={cancelInventoryImportAction}>Cancel</button>
            </div>
          </form>
        );
      })()}

      {sp.job && !imp && <Empty title="Import not found" hint="It may have been removed. Start a new import." />}
    </div>
  );
}
