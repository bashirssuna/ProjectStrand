import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q } from "@/server/db";
import { listFunds, reserveStats, listInvestments, investmentStats, RESERVE_TYPES, INSTRUMENT_TYPES } from "@/server/services/treasury";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Badge, Empty, ProgressBar } from "@/components/ui";
import { money, fmtDate, ccyTotal } from "@/lib/format";
import { currencyOptions } from "@/lib/currencies";
import { label } from "@/lib/enums";
import { createReserveFundAction, createInvestmentAction } from "@/app/actions";

export default async function TreasuryPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
  const [funds, rStats, investments, iStats, org] = await Promise.all([
    listFunds(orgId), reserveStats(orgId), listInvestments(orgId), investmentStats(orgId),
    q<{ baseCurrency: string }>(`SELECT base_currency AS "baseCurrency" FROM organization WHERE id=$1`, [orgId]),
  ]);
  const baseCcy = org[0]?.baseCurrency || "USD";
  const reserves = ccyTotal(rStats.total, baseCcy), invested = ccyTotal(iStats.invested, baseCcy), interest = ccyTotal(iStats.interestEarned, baseCcy);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Reserves & investments" subtitle={`Designated reserves and placed investments for ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.err === "resname" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A reserve name is required.</div>}
      {sp.err === "invname" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>An investment name is required.</div>}

      {/* ---------- Reserves ---------- */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Stat label="Reserve funds" value={String(rStats.funds)} />
        <Stat label="Total reserves" value={reserves.value} tone={reserves.parts.some(([, v]) => v > 0) ? "ok" : undefined} />
        <Stat label="Invested (active)" value={invested.value} />
        <Stat label="Interest earned" value={interest.value} tone={interest.parts.some(([, v]) => v > 0) ? "ok" : undefined} />
      </div>
      <p className="text-xs mb-5" style={{ color: "var(--muted)" }}>Cross-fund totals assume a common base currency; per-item figures use each item&apos;s own currency.</p>

      <SectionTitle>Reserve funds</SectionTitle>
      <div className="mt-2 mb-3">
        {funds.length === 0 ? <Empty title="No reserve funds" hint="Create a designated reserve below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Fund</th><th className="th text-left">Type</th><th className="th text-right">Balance</th><th className="th text-left">Target</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>
                {funds.map((f) => (
                  <tr key={f.id}>
                    <td className="td font-medium">{f.name}</td>
                    <td className="td">{label(f.type)}</td>
                    <td className="td text-right whitespace-nowrap">{money(f.balance, f.currency)}</td>
                    <td className="td" style={{ minWidth: 120 }}>{f.targetAmount ? <div className="flex items-center gap-2"><ProgressBar value={Math.min(Math.round((f.balance / f.targetAmount) * 100), 100)} /><span className="text-xs" style={{ color: "var(--muted)" }}>{money(f.targetAmount, f.currency)}</span></div> : "—"}</td>
                    <td className="td"><StatusBadge status={f.status} /></td>
                    <td className="td text-right"><Link href={`/finance/treasury/reserve/${f.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <details className="card p-4 mb-6">
        <summary className="text-sm font-medium cursor-pointer">+ New reserve fund</summary>
        <form action={createReserveFundAction} className="grid sm:grid-cols-2 gap-3 mt-3">
          <Field label="Name *"><input name="name" required className="input" placeholder="e.g. General Reserve" /></Field>
          <Field label="Type"><select name="type" className="select">{RESERVE_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Currency"><select name="currency" defaultValue={baseCcy} className="select">{currencyOptions(baseCcy).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Target amount (optional)"><input name="targetAmount" type="number" step="0.01" min="0" className="input" /></Field>
          <Field label="Opening allocation (optional)"><input name="opening" type="number" step="0.01" min="0" className="input" /></Field>
          <Field label="Purpose"><input name="purpose" className="input" /></Field>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Create reserve</button></div>
        </form>
      </details>

      {/* ---------- Investments ---------- */}
      <div className="flex items-center justify-between">
        <SectionTitle>Investments</SectionTitle>
        {(iStats.maturedDue > 0 || iStats.maturingSoon > 0) && <span className="text-xs" style={{ color: iStats.maturedDue ? "var(--danger)" : "var(--warn)" }}>{iStats.maturedDue > 0 ? `${iStats.maturedDue} matured & due` : `${iStats.maturingSoon} maturing within 30 days`}</span>}
      </div>
      <div className="mt-2 mb-3">
        {investments.length === 0 ? <Empty title="No investments" hint="Record a placement below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Investment</th><th className="th text-left">Instrument</th><th className="th text-right">Outstanding</th><th className="th text-right">Interest</th><th className="th text-left">Matures</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>
                {investments.map((i) => (
                  <tr key={i.id}>
                    <td className="td"><div className="font-medium">{i.name}</div>{i.institution && <div className="text-xs" style={{ color: "var(--muted)" }}>{i.institution}{i.interestRate != null ? ` · ${i.interestRate}%` : ""}</div>}</td>
                    <td className="td">{label(i.instrumentType)}</td>
                    <td className="td text-right whitespace-nowrap">{money(i.outstanding, i.currency)}</td>
                    <td className="td text-right whitespace-nowrap" style={{ color: i.interestEarned ? "var(--ok)" : undefined }}>{money(i.interestEarned, i.currency)}</td>
                    <td className="td whitespace-nowrap">{i.maturityDate ? fmtDate(i.maturityDate) : "—"}{i.maturityFlag === "matured_due" && <span className="ml-1" style={{ color: "var(--danger)" }}>•</span>}{i.maturityFlag === "maturing_soon" && <span className="ml-1" style={{ color: "var(--warn)" }}>•</span>}</td>
                    <td className="td"><StatusBadge status={i.status} /></td>
                    <td className="td text-right"><Link href={`/finance/treasury/investment/${i.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <details className="card p-4">
        <summary className="text-sm font-medium cursor-pointer">+ New investment</summary>
        <form action={createInvestmentAction} className="grid sm:grid-cols-2 gap-3 mt-3">
          <Field label="Name *"><input name="name" required className="input" placeholder="e.g. Stanbic 90-day FD" /></Field>
          <Field label="Institution"><input name="institution" className="input" placeholder="Bank / broker" /></Field>
          <Field label="Instrument"><select name="instrumentType" className="select">{INSTRUMENT_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Currency"><select name="currency" defaultValue={baseCcy} className="select">{currencyOptions(baseCcy).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Principal"><input name="principal" type="number" step="0.01" min="0" className="input" /></Field>
          <Field label="Interest rate (% p.a.)"><input name="interestRate" type="number" step="0.001" min="0" className="input" /></Field>
          <Field label="Placement date"><input name="placementDate" type="date" className="input" /></Field>
          <Field label="Maturity date"><input name="maturityDate" type="date" className="input" /></Field>
          <Field label="Expected maturity value"><input name="expectedValue" type="number" step="0.01" min="0" className="input" /></Field>
          <Field label="Reference"><input name="reference" className="input" /></Field>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Record investment</button></div>
        </form>
      </details>
    </div>
  );
}
