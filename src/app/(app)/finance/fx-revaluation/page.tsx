import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { revaluationWorksheet } from "@/server/services/fxreval";
import { PageHeader, SectionTitle, Field, Stat, Badge, Empty } from "@/components/ui";
import { money, fmtDate, num } from "@/lib/format";
import { currencyOptions } from "@/lib/currencies";
import { postForeignEntryAction, postFxRevaluationAction } from "@/app/actions";

export default async function FxRevaluationPage({ searchParams }: { searchParams: Promise<{ asof?: string; err?: string; posted?: string; revalued?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const asOf = (sp.asof && /^\d{4}-\d{2}-\d{2}$/.test(sp.asof)) ? sp.asof : today;

  const accCount = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM ledger_account WHERE org_id=$1`, [orgId]))?.c ?? 0;
  const base = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";

  if (accCount === 0) {
    return (
      <div className="max-w-4xl">
        <PageHeader title="Foreign-currency revaluation" subtitle={orgName} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
        <Empty title="Set up your chart of accounts first" hint="FX revaluation posts a balanced journal to your general ledger, so the ledger needs to be initialised under Finance before you can record foreign entries or revalue balances." />
      </div>
    );
  }

  const [accounts, ws] = await Promise.all([
    q<{ id: string; code: string; name: string; accountType: string }>(
      `SELECT id, code, name, account_type AS "accountType" FROM ledger_account WHERE org_id=$1 AND is_active ORDER BY code`, [orgId]),
    revaluationWorksheet(orgId, asOf),
  ]);
  const postable = ws.items.filter((i) => i.converted && i.fxDiff != null && Math.abs(i.fxDiff) >= 0.01).length > 0;

  return (
    <div className="max-w-4xl">
      <PageHeader title="Foreign-currency revaluation" subtitle={`Transaction-date conversion & period-end FX gain/loss for ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />

      {sp.posted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Foreign-currency entry posted to the ledger.</div>}
      {sp.revalued && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Revaluation posted as journal {sp.revalued}.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{sp.err === "fields" ? "Choose two different accounts, a currency and a positive amount." : sp.err}</div>}

      {/* Record a foreign-currency entry */}
      <SectionTitle>Record a foreign-currency entry</SectionTitle>
      <p className="text-xs mt-1 mb-2" style={{ color: "var(--muted)" }}>
        A foreign receipt or payment (e.g. a USD grant tranche into a USD bank account). The amount is converted to {base} at the rate on the transaction date and the foreign exposure is kept on the line, so it can be revalued later. If no rate is on file for that date you can enter one.
      </p>
      <form action={postForeignEntryAction} className="card p-4 grid sm:grid-cols-2 gap-3 mb-6">
        <Field label="Date"><input type="date" name="date" defaultValue={today} className="input" /></Field>
        <Field label="Currency"><select name="currency" className="select" defaultValue={currencyOptions(base).find((c) => c !== base) ?? base}>{currencyOptions(base).map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
        <Field label="Debit account (where value goes)"><select name="debitAccountId" className="select" required>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></Field>
        <Field label="Credit account (where value comes from)"><select name="creditAccountId" className="select" required>{accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}</select></Field>
        <Field label="Foreign amount"><input name="foreignAmount" type="number" step="0.01" min="0" className="input" placeholder="0.00" required /></Field>
        <Field label={`Rate (optional — ${base} per 1 unit)`}><input name="rate" type="number" step="0.000001" min="0" className="input" placeholder="leave blank to use rate on file" /></Field>
        <Field label="Reference"><input name="reference" className="input" placeholder="e.g. bank ref / receipt no." /></Field>
        <Field label="Memo"><input name="memo" className="input" placeholder="description" /></Field>
        <div className="sm:col-span-2"><button className="btn btn-primary" type="submit">Post entry</button></div>
      </form>

      {/* Revaluation worksheet */}
      <SectionTitle>Period-end revaluation</SectionTitle>
      <form method="GET" className="flex items-end gap-2 mt-2 mb-3">
        <Field label="Revalue as at"><input type="date" name="asof" defaultValue={asOf} className="input" /></Field>
        <button className="btn btn-sm" type="submit">Update</button>
      </form>

      {ws.items.length === 0 ? (
        <Empty title="No foreign-currency balances to revalue" hint={`As at ${fmtDate(asOf)} there are no open foreign-currency monetary balances in the ledger. Record foreign entries above and they will appear here.`} />
      ) : (
        <>
          <div className="card overflow-x-auto mb-3">
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Account</th><th className="th text-left">Ccy</th>
                <th className="th text-right">Foreign balance</th><th className="th text-right">Booked ({base})</th>
                <th className="th text-right">Closing rate</th><th className="th text-right">Revalued ({base})</th><th className="th text-right">FX gain/(loss)</th>
              </tr></thead>
              <tbody>
                {ws.items.map((i, idx) => (
                  <tr key={idx}>
                    <td className="td"><span className="font-medium">{i.code}</span> {i.name}</td>
                    <td className="td">{i.currency}</td>
                    <td className="td text-right whitespace-nowrap">{money(i.foreignBal, i.currency)}</td>
                    <td className="td text-right whitespace-nowrap">{money(i.currentBase, base)}</td>
                    <td className="td text-right whitespace-nowrap">{i.converted ? <>{num(i.rate!)}<span style={{ color: "var(--muted)" }} className="text-xs"> · {i.rateAsOf ? fmtDate(i.rateAsOf) : ""}</span></> : <Badge tone="warn">no rate</Badge>}</td>
                    <td className="td text-right whitespace-nowrap">{i.revaluedBase != null ? money(i.revaluedBase, base) : "—"}</td>
                    <td className="td text-right whitespace-nowrap" style={{ color: i.fxDiff == null ? undefined : i.fxDiff > 0 ? "var(--ok)" : i.fxDiff < 0 ? "var(--danger)" : undefined }}>{i.fxDiff != null ? money(i.fxDiff, base) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid sm:grid-cols-3 gap-3 mb-3">
            <Stat label={`Net FX ${ws.totalGainLoss >= 0 ? "gain" : "loss"}`} value={money(ws.totalGainLoss, base)} tone={ws.totalGainLoss > 0 ? "ok" : ws.totalGainLoss < 0 ? "danger" : undefined} />
            <Stat label="Balances revalued" value={String(ws.items.length - ws.unconverted.length)} sub={ws.unconverted.length ? `${ws.unconverted.length} skipped` : undefined} />
            <Stat label="As at" value={fmtDate(asOf)} />
          </div>

          {ws.unconverted.length > 0 && (
            <div className="card p-3 mb-3 text-sm" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>
              No rate on file as at {fmtDate(asOf)} for {[...new Set(ws.unconverted.map((u) => u.currency))].join(", ")} — {ws.unconverted.length === 1 ? "that balance is" : "those balances are"} excluded from the revaluation (never converted at par). <Link href="/finance/currency" style={{ color: "var(--brand)" }}>Add rates →</Link>
            </div>
          )}

          <form action={postFxRevaluationAction}>
            <input type="hidden" name="asOf" value={asOf} />
            <button className="btn btn-primary" type="submit" disabled={!postable}>Post revaluation as at {fmtDate(asOf)}</button>
            {!postable && <span className="text-xs ml-2" style={{ color: "var(--muted)" }}>Nothing with a rate difference to post.</span>}
          </form>
          <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
            Posts one balanced journal: each foreign balance is adjusted to its closing-rate value in {base}, with the net difference taken to the Foreign exchange gain/(loss) account. Re-running at a later date posts only the incremental movement.
          </p>
        </>
      )}
    </div>
  );
}
