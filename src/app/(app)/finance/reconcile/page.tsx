import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { reconciliationView } from "@/server/services/finance_ops";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { addBankLineAction, toggleBankLineAction } from "@/app/actions";

export default async function ReconcilePage({ searchParams }: { searchParams: Promise<{ account?: string; added?: string; err?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const cashAccts = await q<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='asset' AND (code LIKE '10%' OR name ILIKE '%cash%' OR name ILIKE '%bank%') ORDER BY code`, [orgId]);
  const accountId = sp.account || cashAccts[0]?.id;

  if (!accountId) {
    return <div className="max-w-4xl"><PageHeader title="Bank reconciliation" actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} /><Empty title="No cash/bank accounts" hint="Add a cash or bank account in the chart of accounts first." /></div>;
  }
  const view = await reconciliationView(orgId, accountId);
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";

  return (
    <div className="max-w-4xl">
      <PageHeader title="Bank reconciliation" subtitle={`Account: ${view.accountName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      <div className="flex flex-wrap gap-2 mb-4">
        {cashAccts.map((a) => (
          <Link key={a.id} href={`/finance/reconcile?account=${a.id}`} className="btn btn-sm" style={a.id === accountId ? { background: "var(--surface)", borderColor: "var(--brand)" } : undefined}>{a.code} {a.name}</Link>
        ))}
      </div>
      {sp.added && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Statement line added.</div>}

      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="card p-3"><div className="label">Ledger balance</div><div className="font-semibold tabular-nums">{money(view.glBalance, c)}</div></div>
        <div className="card p-3"><div className="label">Statement balance</div><div className="font-semibold tabular-nums">{money(view.statementBalance, c)}</div></div>
        <div className="card p-3"><div className="label">Difference</div><div className="font-semibold tabular-nums" style={{ color: view.difference === 0 ? "var(--ok)" : "var(--danger)" }}>{money(view.difference, c)}</div></div>
      </div>
      <div className="mb-5">{view.difference === 0 ? <Badge tone="ok">Reconciled — ledger matches the statement</Badge> : <Badge tone="warn">Unreconciled difference of {money(Math.abs(view.difference), c)}</Badge>}</div>

      <SectionTitle>Unreconciled statement lines</SectionTitle>
      {view.unreconciledLines.length === 0 ? <p className="text-sm mb-5" style={{ color: "var(--muted)" }}>No unreconciled lines.</p> : (
        <div className="card overflow-x-auto mb-5">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Date</th><th className="th text-left">Description</th><th className="th text-right">Amount</th><th className="th" /></tr></thead>
            <tbody>
              {view.unreconciledLines.map((l) => (
                <tr key={l.id}>
                  <td className="td whitespace-nowrap">{fmtDate(l.date)}</td>
                  <td className="td">{l.description ?? "—"}</td>
                  <td className="td text-right tabular-nums" style={{ color: l.amount < 0 ? "var(--danger)" : undefined }}>{money(l.amount, c)}</td>
                  <td className="td text-right">
                    <form action={toggleBankLineAction}><input type="hidden" name="lineId" value={l.id} /><input type="hidden" name="accountId" value={accountId} /><button className="btn btn-sm" type="submit">Mark reconciled</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Add a bank statement line</SectionTitle>
      <form action={addBankLineAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-end">
        <input type="hidden" name="accountId" value={accountId} />
        <Field label="Date"><input type="date" name="txnDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
        <div className="sm:col-span-2"><Field label="Description"><input name="description" className="input" placeholder="As it appears on the statement" /></Field></div>
        <Field label="Amount (+in / −out)"><input type="number" step="0.01" name="amount" required className="input" /></Field>
        <div className="sm:col-span-4 flex justify-end"><button className="btn btn-primary" type="submit">Add line</button></div>
      </form>
      <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Enter statement lines (positive for money in, negative for money out), then tick the ones that match ledger entries. When the difference reaches zero, the account is reconciled.</p>
    </div>
  );
}
