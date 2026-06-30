import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q } from "@/server/db";
import { listForecasts } from "@/server/services/cashflow";
import { accountStats } from "@/server/services/pettycash";
import { PageHeader, SectionTitle, Field, StatusBadge, Empty } from "@/components/ui";
import { money, fmtDate, ccyTotal } from "@/lib/format";
import { currencyOptions } from "@/lib/currencies";
import { createForecastAction } from "@/app/actions";

export default async function CashForecastPage({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
  const [forecasts, pcStats, org] = await Promise.all([
    listForecasts(orgId),
    accountStats(orgId),
    q<{ baseCurrency: string }>(`SELECT base_currency AS "baseCurrency" FROM organization WHERE id=$1`, [orgId]),
  ]);
  const baseCcy = org[0]?.baseCurrency || "USD";
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-4xl">
      <PageHeader title="Cash forecast" subtitle={`Forward cash-position projections for ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.err === "name" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A forecast name is required.</div>}

      <SectionTitle>Forecasts</SectionTitle>
      <div className="mt-2 mb-6">
        {forecasts.length === 0 ? <Empty title="No forecasts" hint="Create a rolling cash forecast below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Name</th><th className="th text-right">Opening</th><th className="th text-left">From</th><th className="th text-left">Horizon</th><th className="th text-left">Lines</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>
                {forecasts.map((f) => (
                  <tr key={f.id}>
                    <td className="td font-medium">{f.name}</td>
                    <td className="td text-right whitespace-nowrap">{money(f.openingBalance, f.currency)}</td>
                    <td className="td whitespace-nowrap">{fmtDate(f.startDate)}</td>
                    <td className="td">{f.months} mo</td>
                    <td className="td">{f.lines}</td>
                    <td className="td"><StatusBadge status={f.status} /></td>
                    <td className="td text-right"><Link href={`/finance/cash-forecast/${f.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card p-4">
        <SectionTitle>New forecast</SectionTitle>
        <p className="text-xs mt-1 mb-2" style={{ color: "var(--muted)" }}>Tip: petty cash on hand is currently {ccyTotal(pcStats.onHand, baseCcy).value} — add bank balances for your opening cash position.</p>
        <form action={createForecastAction} className="grid sm:grid-cols-2 gap-3 mt-1">
          <Field label="Name *"><input name="name" required className="input" placeholder="e.g. FY2026 Operating Cash Forecast" /></Field>
          <Field label="Currency"><select name="currency" defaultValue={baseCcy} className="select">{currencyOptions(baseCcy).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
          <Field label="Opening cash balance"><input name="openingBalance" type="number" step="0.01" className="input" placeholder="0.00" /></Field>
          <Field label="Start month"><input name="startDate" type="date" defaultValue={today} className="input" /></Field>
          <Field label="Horizon (months, max 36)"><input name="months" type="number" min="1" max="36" defaultValue="6" className="input" /></Field>
          <div className="flex flex-col gap-1 justify-end text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" name="includeFunding" defaultChecked /> Pull expected funding tranches</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="includeInvestments" defaultChecked /> Pull investment maturities</label>
          </div>
          <div className="sm:col-span-2"><Field label="Notes"><input name="notes" className="input" /></Field></div>
          <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Create forecast</button></div>
        </form>
      </div>
    </div>
  );
}
