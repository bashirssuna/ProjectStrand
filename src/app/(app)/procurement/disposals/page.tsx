import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProcOrg } from "../_guard";
import { isModuleEnabled } from "@/server/modules";
import { q, one } from "@/server/db";
import { listDisposals, disposalStats } from "@/server/services/disposals";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { money } from "@/lib/format";
import { label } from "@/lib/enums";
import { currencyOptions } from "@/lib/currencies";
import { createDisposalAction } from "@/app/actions";

const METHODS = ["sale", "transfer", "donation", "destruction", "write_off", "other"];
const STATUSES = ["draft", "submitted", "board_survey", "approved", "rejected", "disposed"];

export default async function Disposals({ searchParams }: { searchParams: Promise<{ status?: string; method?: string; deleted?: string }> }) {
  const { orgId, orgName } = await requireProcOrg();
  if (!(await isModuleEnabled(orgId, "public_procurement"))) redirect("/procurement");
  const sp = await searchParams;
  const [rows, stats, assets, committees, items] = await Promise.all([
    listDisposals(orgId, { status: sp.status, method: sp.method }),
    disposalStats(orgId),
    q<{ id: string; name: string; tag: string | null }>(`SELECT id, name, tag FROM fixed_asset WHERE org_id=$1 AND status='active' ORDER BY name`, [orgId]),
    q<{ id: string; name: string }>(`SELECT id, name FROM proc_committee WHERE org_id=$1 AND type='disposal' AND status='active' ORDER BY name`, [orgId]),
    q<{ id: string; name: string }>(`SELECT id, name FROM stock_item WHERE org_id=$1 AND status='active' ORDER BY name`, [orgId]),
  ]);
  const baseCur = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";

  return (
    <div className="max-w-5xl">
      <PageHeader title="Disposal management" subtitle={`Asset & stores disposal for ${orgName}`} actions={<Link href="/procurement" className="btn btn-sm">← Procurement</Link>} />
      {sp.deleted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>Disposal deleted.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Disposals" value={String(stats.total)} />
        <Stat label="In progress" value={String(stats.pending)} />
        <Stat label="Completed" value={String(stats.disposed)} />
        <Stat label="Proceeds" value={money(stats.proceeds, baseCur)} />
      </div>

      <form className="card p-4 mb-5 grid sm:grid-cols-3 gap-3 items-end">
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select"><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <Field label="Method"><select name="method" defaultValue={sp.method ?? ""} className="select"><option value="">All</option>{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></Field>
        <div className="flex gap-2"><button className="btn btn-sm btn-primary" type="submit">Apply</button><Link href="/procurement/disposals" className="btn btn-sm">Reset</Link></div>
      </form>

      {rows.length === 0 ? (
        <Empty title="No disposals yet" hint="Raise a disposal, route it through the board of survey and disposal committee, then record the outcome." />
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Item</th><th className="th text-left">Method</th><th className="th text-right">Est. value</th><th className="th text-left">Committee</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id}>
                  <td className="td"><Link href={`/procurement/disposals/${d.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{d.reference ? <span className="font-mono text-xs mr-1">{d.reference}</span> : null}{d.description}</Link>{d.assetName ? <div className="text-xs" style={{ color: "var(--muted)" }}>Asset: {d.assetName}</div> : null}</td>
                  <td className="td">{label(d.method)}</td>
                  <td className="td text-right tabular-nums">{money(d.estimatedValue, d.currency ?? baseCur)}</td>
                  <td className="td">{d.committeeName ?? "—"}</td>
                  <td className="td"><StatusBadge status={d.status} /></td>
                  <td className="td text-right"><Link href={`/procurement/disposals/${d.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-4">
        <SectionTitle>New disposal</SectionTitle>
        <form action={createDisposalAction} className="grid sm:grid-cols-2 gap-3">
          <Field label="Reference"><input name="reference" className="input" placeholder="e.g. DSP-2026-001" /></Field>
          <Field label="Description"><input name="description" required className="input" placeholder="What is being disposed" /></Field>
          <Field label="Method"><select name="method" defaultValue="sale" className="select">{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></Field>
          <Field label="Linked asset (optional)"><select name="assetId" className="select"><option value="">—</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.tag ? `${a.tag} · ` : ""}{a.name}</option>)}</select></Field>
          <Field label="Linked stock item (optional)"><select name="stockItemId" className="select"><option value="">—</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>
          <Field label="Quantity"><input type="number" step="any" name="quantity" className="input" /></Field>
          <Field label="Estimated value"><input type="number" step="any" min={0} name="estimatedValue" defaultValue={0} className="input" /></Field>
          <Field label="Currency"><select name="currency" defaultValue={baseCur} className="select">{currencyOptions(baseCur).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Disposal committee"><select name="committeeId" className="select"><option value="">—</option>{committees.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <div className="sm:col-span-2"><Field label="Reason"><textarea name="reason" rows={2} className="textarea" placeholder="Why this is being disposed (obsolete, damaged, end of life…)" /></Field></div>
          <div><button className="btn btn-primary" type="submit">Create disposal</button></div>
        </form>
        {committees.length === 0 && <p className="text-xs mt-3" style={{ color: "var(--warn)" }}>Tip: set up a Disposal committee under Procurement → Committees to assign here.</p>}
      </div>
    </div>
  );
}
