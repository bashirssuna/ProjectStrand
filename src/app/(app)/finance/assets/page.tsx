import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { createAssetAction, depreciateAssetAction, disposeAssetAction } from "@/app/actions";

export default async function AssetsPage({ searchParams }: { searchParams: Promise<{ created?: string; dep?: string; err?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const base = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);
  const assets = await q<{
    id: string; tag: string | null; name: string; category: string | null; acquiredOn: string; cost: number;
    currency: string; accumulated: number; life: number; salvage: number; status: string; custodian: string | null;
  }>(
    `SELECT id, tag, name, category, acquired_on AS "acquiredOn", cost::float, currency,
            accumulated_depreciation::float AS accumulated, useful_life_months AS life, salvage_value::float AS salvage,
            status, custodian FROM fixed_asset WHERE org_id=$1 ORDER BY acquired_on DESC`, [orgId]
  );
  const thisMonth = new Date().toISOString().slice(0, 7);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Asset register" subtitle="Fixed assets with straight-line depreciation" actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Asset added to the register.</div>}
      {sp.dep === "ok" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Depreciation posted for this month.</div>}
      {sp.dep === "none" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)", borderColor: "var(--border)" }}>Nothing to depreciate (already run this month, or fully depreciated).</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Name and a positive cost are required.</div>}

      <SectionTitle>Assets</SectionTitle>
      {assets.length === 0 ? <Empty title="No assets yet" hint="Add one below; you can optionally post the acquisition to the ledger." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Tag</th><th className="th text-left">Name</th><th className="th text-right">Cost</th><th className="th text-right">Accum. dep.</th><th className="th text-right">Net book value</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {assets.map((a) => {
                const nbv = a.cost - a.accumulated;
                return (
                  <tr key={a.id}>
                    <td className="td font-mono text-xs">{a.tag ?? "—"}</td>
                    <td className="td">{a.name}{a.custodian ? <span className="text-xs block" style={{ color: "var(--muted)" }}>{a.custodian}</span> : null}</td>
                    <td className="td text-right tabular-nums">{money(a.cost, a.currency)}</td>
                    <td className="td text-right tabular-nums">{money(a.accumulated, a.currency)}</td>
                    <td className="td text-right tabular-nums font-medium">{money(nbv, a.currency)}</td>
                    <td className="td">{a.status === "active" ? <Badge tone="ok">active</Badge> : <Badge tone="muted">disposed</Badge>}</td>
                    <td className="td text-right whitespace-nowrap">
                      {a.status === "active" && (
                        <div className="flex gap-1 justify-end">
                          <form action={depreciateAssetAction}><input type="hidden" name="assetId" value={a.id} /><input type="hidden" name="period" value={thisMonth} /><button className="btn btn-sm" type="submit">Depreciate {thisMonth}</button></form>
                          <form action={disposeAssetAction}><input type="hidden" name="assetId" value={a.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Dispose</button></form>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Add an asset</SectionTitle>
      <form action={createAssetAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <Field label="Name"><input name="name" required className="input" placeholder="e.g. Toyota Land Cruiser" /></Field>
        <Field label="Asset tag / serial"><input name="tag" className="input" /></Field>
        <Field label="Category"><input name="category" className="input" placeholder="Vehicle, Laptop…" /></Field>
        <Field label="Cost"><input type="number" step="0.01" name="cost" required className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue={base} className="input" /></Field>
        <Field label="Acquired on"><input type="date" name="acquiredOn" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
        <Field label="Useful life (months)"><input type="number" name="usefulLifeMonths" defaultValue={36} className="input" /></Field>
        <Field label="Salvage value"><input type="number" step="0.01" name="salvageValue" defaultValue={0} className="input" /></Field>
        <Field label="Custodian"><input name="custodian" className="input" /></Field>
        <Field label="Location"><input name="location" className="input" /></Field>
        <Field label="Project (optional)">
          <select name="projectId" className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select>
        </Field>
        <label className="flex items-center gap-2 text-sm self-end pb-2">
          <input type="checkbox" name="postAcquisition" defaultChecked /> Post acquisition to ledger
        </label>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Add to register</button></div>
      </form>
    </div>
  );
}
