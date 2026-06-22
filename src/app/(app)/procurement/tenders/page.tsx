import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProcOrg } from "../_guard";
import { isModuleEnabled } from "@/server/modules";
import { q, one } from "@/server/db";
import { listTenders, tenderStats } from "@/server/services/tenders";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { currencyOptions } from "@/lib/currencies";
import { createTenderAction } from "@/app/actions";

const METHODS = ["open_domestic", "open_international", "restricted", "rfq", "direct", "other"];
const CATEGORIES = ["goods", "works", "services", "consultancy"];
const STATUSES = ["draft", "advertised", "closed", "evaluation", "awarded", "cancelled"];

export default async function Tenders({ searchParams }: { searchParams: Promise<{ status?: string; method?: string; category?: string; search?: string; deleted?: string }> }) {
  const { orgId, orgName } = await requireProcOrg();
  if (!(await isModuleEnabled(orgId, "public_procurement"))) redirect("/procurement");
  const sp = await searchParams;
  const [rows, stats, committees] = await Promise.all([
    listTenders(orgId, { status: sp.status, method: sp.method, category: sp.category, search: sp.search }),
    tenderStats(orgId),
    q<{ id: string; name: string }>(`SELECT id, name FROM proc_committee WHERE org_id=$1 AND type='evaluation' AND status='active' ORDER BY name`, [orgId]),
  ]);
  const baseCur = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";

  return (
    <div className="max-w-5xl">
      <PageHeader title="Tenders & bids" subtitle={`Competitive procurement for ${orgName}`} actions={<Link href="/procurement" className="btn btn-sm">← Procurement</Link>} />
      {sp.deleted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>Tender deleted.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Tenders" value={String(stats.total)} />
        <Stat label="Open" value={String(stats.open)} />
        <Stat label="In evaluation" value={String(stats.evaluation)} />
        <Stat label="Awarded" value={String(stats.awarded)} />
      </div>

      <form className="card p-4 mb-5 grid sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
        <div className="lg:col-span-2"><Field label="Search"><input name="search" defaultValue={sp.search ?? ""} className="input" placeholder="Title or reference" /></Field></div>
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select"><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <Field label="Method"><select name="method" defaultValue={sp.method ?? ""} className="select"><option value="">All</option>{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></Field>
        <div className="flex gap-2"><button className="btn btn-sm btn-primary" type="submit">Apply</button><Link href="/procurement/tenders" className="btn btn-sm">Reset</Link></div>
      </form>

      {rows.length === 0 ? (
        <Empty title="No tenders yet" hint="Create a tender, advertise it, record and open bids, evaluate, and award." />
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Tender</th><th className="th text-left">Method</th><th className="th text-left">Category</th><th className="th text-right">Est. value</th><th className="th text-right">Bids</th><th className="th text-left">Closing</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="td"><Link href={`/procurement/tenders/${t.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{t.reference ? <span className="font-mono text-xs mr-1">{t.reference}</span> : null}{t.title}</Link></td>
                  <td className="td">{label(t.method)}</td>
                  <td className="td">{label(t.category)}</td>
                  <td className="td text-right tabular-nums">{money(t.estimatedValue, t.currency ?? baseCur)}</td>
                  <td className="td text-right tabular-nums">{t.bidCount}</td>
                  <td className="td whitespace-nowrap">{t.closingDate ? fmtDate(t.closingDate) : "—"}</td>
                  <td className="td"><StatusBadge status={t.status} /></td>
                  <td className="td text-right"><Link href={`/procurement/tenders/${t.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-4">
        <SectionTitle>New tender</SectionTitle>
        <form action={createTenderAction} className="grid sm:grid-cols-2 gap-3">
          <Field label="Reference"><input name="reference" className="input" placeholder="e.g. ACHR/SUPLS/2026/001" /></Field>
          <Field label="Title"><input name="title" required className="input" placeholder="Subject of procurement" /></Field>
          <Field label="Method"><select name="method" defaultValue="open_domestic" className="select">{METHODS.map((m) => <option key={m} value={m}>{label(m)}</option>)}</select></Field>
          <Field label="Category"><select name="category" defaultValue="goods" className="select">{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select></Field>
          <Field label="Estimated value"><input type="number" step="any" min={0} name="estimatedValue" defaultValue={0} className="input" /></Field>
          <Field label="Currency"><select name="currency" defaultValue={baseCur} className="select">{currencyOptions(baseCur).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Evaluation committee"><select name="committeeId" className="select"><option value="">—</option>{committees.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <div className="sm:col-span-2"><Field label="Description"><textarea name="description" rows={2} className="textarea" placeholder="Scope / specifications / TOR summary" /></Field></div>
          <div><button className="btn btn-primary" type="submit">Create tender</button></div>
        </form>
        {committees.length === 0 && <p className="text-xs mt-3" style={{ color: "var(--warn)" }}>Tip: set up an Evaluation committee under Procurement → Committees to assign here.</p>}
      </div>
    </div>
  );
}
