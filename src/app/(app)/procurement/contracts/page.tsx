import Link from "next/link";
import { redirect } from "next/navigation";
import { requireProcOrg } from "../_guard";
import { isModuleEnabled } from "@/server/modules";
import { q, one } from "@/server/db";
import { listContracts, contractStats } from "@/server/services/contracts";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { money, fmtDate, pct, ccyTotal } from "@/lib/format";
import { label } from "@/lib/enums";
import { currencyOptions } from "@/lib/currencies";
import { createContractAction } from "@/app/actions";
import { ExportMenu } from "@/components/export-menu";

const STATUSES = ["draft", "active", "suspended", "completed", "terminated"];

export default async function Contracts({ searchParams }: { searchParams: Promise<{ status?: string; search?: string; deleted?: string; imported?: string; skipped?: string }> }) {
  const { orgId, orgName } = await requireProcOrg();
  if (!(await isModuleEnabled(orgId, "public_procurement"))) redirect("/procurement");
  const sp = await searchParams;
  const [rows, stats, vendors] = await Promise.all([
    listContracts(orgId, { status: sp.status, search: sp.search }),
    contractStats(orgId),
    q<{ id: string; name: string }>(`SELECT id, name FROM vendor WHERE org_id=$1 ORDER BY name`, [orgId]),
  ]);
  const baseCur = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  const totalValue = ccyTotal(stats.valueByCcy, baseCur);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Contracts" subtitle={`Contract management for ${orgName}`} actions={<div className="flex flex-wrap gap-2 no-print"><Link href="/procurement/import/contract" className="btn btn-sm">Import Excel</Link><Link href="/print/procurement/contracts" target="_blank" className="btn btn-sm">Print</Link><ExportMenu scope="contracts" /><Link href="/procurement" className="btn btn-sm">← Procurement</Link></div>} />
      {sp.imported && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Imported {sp.imported} contract{sp.imported === "1" ? "" : "s"}{sp.skipped ? ` · ${sp.skipped} row${sp.skipped === "1" ? "" : "s"} skipped (no title)` : ""}.</div>}
      {sp.deleted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>Contract deleted.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Contracts" value={String(stats.total)} />
        <Stat label="Active" value={String(stats.active)} />
        <Stat label="Completed" value={String(stats.completed)} />
        <Stat label="Total value" value={totalValue.value} sub={totalValue.mixed ? "multiple currencies" : undefined} />
      </div>

      {totalValue.mixed && (
        <div className="card p-3 mb-5 text-sm flex flex-wrap gap-x-5 gap-y-1">
          <span style={{ color: "var(--muted)" }}>Total value by currency:</span>
          {totalValue.parts.map(([c, v]) => <span key={c} className="tabular-nums">{money(v, c)}</span>)}
        </div>
      )}

      <form className="card p-4 mb-5 grid sm:grid-cols-3 gap-3 items-end">
        <div><Field label="Search"><input name="search" defaultValue={sp.search ?? ""} className="input" placeholder="Title, reference or provider" /></Field></div>
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select"><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <div className="flex gap-2"><button className="btn btn-sm btn-primary" type="submit">Apply</button><Link href="/procurement/contracts" className="btn btn-sm">Reset</Link></div>
      </form>

      {rows.length === 0 ? (
        <Empty title="No contracts yet" hint="Register a contract (or create one from an awarded tender) and track delivery, payments and provider performance." />
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Contract</th><th className="th text-left">Provider</th><th className="th text-right">Value</th><th className="th text-right">Paid</th><th className="th text-left">Delivery</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {rows.map((c) => {
                const paidPct = c.contractValue > 0 ? Math.min(100, (c.paid / c.contractValue) * 100) : 0;
                return (
                  <tr key={c.id}>
                    <td className="td"><Link href={`/procurement/contracts/${c.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{c.reference ? <span className="font-mono text-xs mr-1">{c.reference}</span> : null}{c.title}</Link></td>
                    <td className="td">{c.vendorName ?? c.providerName ?? "—"}</td>
                    <td className="td text-right tabular-nums">{money(c.contractValue, c.currency ?? baseCur)}</td>
                    <td className="td text-right tabular-nums">{money(c.paid, c.currency ?? baseCur)}<div className="text-xs" style={{ color: "var(--muted)" }}>{pct(paidPct)}</div></td>
                    <td className="td tabular-nums">{c.milestonesTotal > 0 ? `${c.milestonesDone}/${c.milestonesTotal}` : "—"}</td>
                    <td className="td"><StatusBadge status={c.status} /></td>
                    <td className="td text-right"><Link href={`/procurement/contracts/${c.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card p-4">
        <SectionTitle>New contract</SectionTitle>
        <form action={createContractAction} className="grid sm:grid-cols-2 gap-3">
          <Field label="Reference"><input name="reference" className="input" placeholder="e.g. CTR/2026/014" /></Field>
          <Field label="Title"><input name="title" required className="input" placeholder="Contract title" /></Field>
          <Field label="Provider (vendor)"><select name="vendorId" className="select"><option value="">— not listed —</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
          <Field label="…or provider name"><input name="providerName" className="input" /></Field>
          <Field label="Contract value"><input type="number" step="any" min={0} name="contractValue" defaultValue={0} className="input" /></Field>
          <Field label="Currency"><select name="currency" defaultValue={baseCur} className="select">{currencyOptions(baseCur).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Start date"><input type="date" name="startDate" className="input" /></Field>
          <Field label="End date"><input type="date" name="endDate" className="input" /></Field>
          <div className="sm:col-span-2"><Field label="Scope"><textarea name="scope" rows={2} className="textarea" /></Field></div>
          <div><button className="btn btn-primary" type="submit">Create contract</button></div>
        </form>
      </div>
    </div>
  );
}
