import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProcOrg } from "../../_guard";
import { isModuleEnabled } from "@/server/modules";
import { getImport, importEntity } from "@/server/services/imports";
import { PageHeader, SectionTitle, Field, Empty, Badge } from "@/components/ui";
import { importRegisterUploadAction, confirmRegisterImportAction, cancelRegisterImportAction } from "@/app/actions";

const ERRORS: Record<string, string> = {
  nofile: "Choose a spreadsheet file to upload.",
  parse: "That file could not be read as a spreadsheet. Use .xlsx, .xls or .csv.",
  empty: "The file needs a header row and at least one data row.",
  required: "Map the required column (marked *) before importing.",
};

export default async function RegisterImportPage({ params, searchParams }: { params: Promise<{ entity: string }>; searchParams: Promise<{ job?: string; err?: string; cancelled?: string }> }) {
  const { entity } = await params;
  const spec = importEntity(entity);
  if (!spec) redirect("/procurement");
  const { orgId, orgName } = await requireProcOrg();
  if (spec!.module && !(await isModuleEnabled(orgId, spec!.module))) redirect("/procurement");
  const sp = await searchParams;
  const job = sp.job ? await getImport(orgId, sp.job) : null;
  const fields = spec!.fields;

  return (
    <div className="max-w-4xl">
      <PageHeader title={`Import ${spec!.plural.toLowerCase()} from Excel`} subtitle={`Bulk-add ${spec!.plural.toLowerCase()} for ${orgName}`} actions={<Link href={spec!.redirectTo} className="btn btn-sm">← {spec!.plural}</Link>} />
      {sp.err && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{ERRORS[sp.err] ?? "Something went wrong."}</div>}
      {sp.cancelled && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--muted)" }}>Import cancelled.</div>}

      {!job && (
        <>
          <form action={importRegisterUploadAction} className="card p-4 mb-5">
            <input type="hidden" name="entity" value={entity} />
            <SectionTitle>Upload a spreadsheet</SectionTitle>
            <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
              Upload your existing {spec!.plural.toLowerCase()} list as <strong>.xlsx</strong>, <strong>.xls</strong> or <strong>.csv</strong>. The first row should be column headings.
              Columns are matched automatically (you can correct the mapping next) and nothing is saved until you confirm.
            </p>
            <Field label="Spreadsheet file"><input type="file" name="file" accept=".xlsx,.xls,.csv" required className="input" /></Field>
            <div className="mt-3"><button className="btn btn-primary" type="submit">Upload &amp; preview</button></div>
          </form>

          <div className="card p-4">
            <SectionTitle>Not sure of the format?</SectionTitle>
            <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
              Download a template, fill in your {spec!.plural.toLowerCase()}, and upload it back. Recognised columns:&nbsp;
              {fields.map((f) => f.label.toLowerCase()).join(", ")}. Extra columns are ignored.
            </p>
            <div className="flex flex-wrap gap-2">
              <a href={`/api/export/${entity}-template?format=xlsx`} className="btn btn-sm">Template (.xlsx)</a>
              <a href={`/api/export/${entity}-template?format=csv`} className="btn btn-sm">Template (.csv)</a>
            </div>
          </div>
        </>
      )}

      {job && job.status !== "preview" && (
        <div className="card p-4">
          <p className="text-sm">{job.status === "applied" ? `This import has already been applied (${job.createdCount} ${spec!.plural.toLowerCase()} created).` : "This import was cancelled."}</p>
          <div className="mt-3 flex gap-2">
            <Link href={spec!.redirectTo} className="btn btn-sm btn-primary">Go to {spec!.plural.toLowerCase()}</Link>
            <Link href={`/procurement/import/${entity}`} className="btn btn-sm">New import</Link>
          </div>
        </div>
      )}

      {job && job.status === "preview" && (() => {
        const colOptions = job.header.map((h, i) => ({ i, label: String(h || "").trim() || `Column ${i + 1}` }));
        const preview = job.rows.slice(0, 12);
        return (
          <form action={confirmRegisterImportAction}>
            <input type="hidden" name="entity" value={entity} />
            <input type="hidden" name="importId" value={job.id} />
            <div className="card p-4 mb-5">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                <SectionTitle>Map columns</SectionTitle>
                <Badge tone="info">{job.fileName}</Badge>
              </div>
              <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
                Confirm which spreadsheet column feeds each field. Fields marked <strong>*</strong> are required; rows missing them are skipped. Unmapped fields are left blank.
              </p>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {fields.map((f) => (
                  <Field key={f.key} label={f.required ? `${f.label} *` : f.label}>
                    <select name={`map_${f.key}`} defaultValue={String(job.mapping[f.key] ?? -1)} className="select">
                      <option value="-1">— not mapped —</option>
                      {colOptions.map((c) => <option key={c.i} value={c.i}>{c.label}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
            </div>

            <div className="card overflow-x-auto mb-5">
              <div className="px-4 pt-3 text-xs" style={{ color: "var(--muted)" }}>Preview — first {preview.length} of {job.rows.length} row{job.rows.length === 1 ? "" : "s"}</div>
              <table className="w-full text-sm">
                <thead><tr>{job.header.map((h, i) => <th key={i} className="th text-left whitespace-nowrap">{String(h || "").trim() || `Col ${i + 1}`}</th>)}</tr></thead>
                <tbody>{preview.map((r, ri) => <tr key={ri}>{job.header.map((_, ci) => <td key={ci} className="td whitespace-nowrap">{String(r[ci] ?? "")}</td>)}</tr>)}</tbody>
              </table>
            </div>

            <div className="flex flex-wrap gap-2">
              <button className="btn btn-primary" type="submit">Import {job.rows.length} row{job.rows.length === 1 ? "" : "s"}</button>
              <button className="btn" type="submit" formAction={cancelRegisterImportAction}>Cancel</button>
            </div>
          </form>
        );
      })()}

      {sp.job && !job && <Empty title="Import not found" hint="It may have been removed. Start a new import." />}
    </div>
  );
}
