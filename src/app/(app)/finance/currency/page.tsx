import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { setBaseCurrencyAction, addExchangeRateAction } from "@/app/actions";

export default async function CurrencyPage({ searchParams }: { searchParams: Promise<{ saved?: string; added?: string; err?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const base = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";
  const rates = await q<{ id: string; currency: string; baseCurrency: string; rate: number; asOf: string }>(
    `SELECT id, currency, base_currency AS "baseCurrency", rate::float, as_of AS "asOf" FROM exchange_rate WHERE org_id=$1 ORDER BY currency, as_of DESC`, [orgId]
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title="Currency & exchange rates" subtitle="Base currency and conversion rates for multi-currency posting" actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Base currency updated.</div>}
      {sp.added && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Exchange rate added.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter a currency different from the base and a positive rate.</div>}

      <SectionTitle>Base (reporting) currency</SectionTitle>
      <form action={setBaseCurrencyAction} className="card p-4 flex items-end gap-3 mb-6">
        <Field label="Base currency (3-letter code)"><input name="baseCurrency" defaultValue={base} maxLength={3} className="input" style={{ width: 120, textTransform: "uppercase" }} /></Field>
        <button className="btn btn-primary" type="submit">Save</button>
        <span className="text-xs pb-2" style={{ color: "var(--muted)" }}>All financial statements are reported in this currency. Foreign amounts are converted using the rates below.</span>
      </form>

      <SectionTitle>Exchange rates</SectionTitle>
      {rates.length === 0 ? <Empty title="No exchange rates yet" hint={`Add a rate to convert foreign-currency invoices, receipts and assets into ${base}.`} /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Currency</th><th className="th text-right">Rate</th><th className="th text-left">As of</th></tr></thead>
            <tbody>
              {rates.map((r) => (
                <tr key={r.id}>
                  <td className="td">1 {r.currency} =</td>
                  <td className="td text-right tabular-nums">{r.rate.toLocaleString()} {r.baseCurrency}</td>
                  <td className="td">{fmtDate(r.asOf)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Add an exchange rate</SectionTitle>
      <form action={addExchangeRateAction} className="card p-4 grid sm:grid-cols-3 gap-3 items-end">
        <Field label="Foreign currency"><input name="currency" maxLength={3} required className="input" placeholder="USD" style={{ textTransform: "uppercase" }} /></Field>
        <Field label={`Rate (1 unit = ? ${base})`}><input type="number" step="0.000001" name="rate" required className="input" placeholder="3700" /></Field>
        <Field label="As of"><input type="date" name="asOf" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Add rate</button></div>
      </form>
    </div>
  );
}
