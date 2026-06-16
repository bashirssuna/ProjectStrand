import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { monthlyBankRec } from "@/server/services/finance_ops";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { toggleClearedAction, saveBankRecAction, finalizeBankRecAction } from "@/app/actions";

export default async function ReconcilePage({ searchParams }: { searchParams: Promise<{ account?: string; period?: string; saved?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const cashAccts = await q<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='asset' AND (code LIKE '10%' OR name ILIKE '%cash%' OR name ILIKE '%bank%') ORDER BY code`, [orgId]
  );
  const accountId = sp.account || cashAccts[0]?.id;
  const period = /^\d{4}-\d{2}$/.test(sp.period ?? "") ? sp.period! : new Date().toISOString().slice(0, 7);

  if (!accountId) {
    return <div className="max-w-4xl"><PageHeader title="Bank reconciliation" actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} /><Empty title="No cash/bank accounts" hint="Add a cash or bank account in the chart of accounts first." /></div>;
  }
  const rec = await monthlyBankRec(orgId, accountId, period);
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";
  const locked = rec.status === "finalized";
  const reconciled = rec.difference === 0 && rec.statementClosing !== null;

  const ClearBtn = ({ lineId, cleared }: { lineId: string; cleared: boolean }) => (
    <form action={toggleClearedAction}>
      <input type="hidden" name="lineId" value={lineId} /><input type="hidden" name="accountId" value={accountId} /><input type="hidden" name="period" value={period} />
      <button className="btn btn-sm" type="submit" disabled={locked} style={cleared ? { background: "var(--ok)", color: "#fff", borderColor: "var(--ok)" } : undefined}>{cleared ? "✓ Cleared" : "Mark cleared"}</button>
    </form>
  );
  const MovementRow = ({ m }: { m: typeof rec.movements[number] }) => (
    <tr>
      <td className="td whitespace-nowrap">{fmtDate(m.date)}</td>
      <td className="td"><Badge tone="muted">{label(m.sourceType)}</Badge>{m.reference ? <span className="font-mono text-xs ml-1">{m.reference}</span> : null}</td>
      <td className="td">{m.memo ?? "—"}</td>
      <td className="td text-right tabular-nums">{m.amount > 0 ? money(m.amount, c) : ""}</td>
      <td className="td text-right tabular-nums" style={{ color: "var(--danger)" }}>{m.amount < 0 ? money(-m.amount, c) : ""}</td>
      <td className="td text-right"><ClearBtn lineId={m.lineId} cleared={m.cleared} /></td>
    </tr>
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title="Bank reconciliation" subtitle={`${rec.accountName} · monthly`}
        actions={<div className="flex gap-2 items-center">{locked ? <Badge tone="ok">Finalised</Badge> : reconciled ? <Badge tone="ok">Reconciled</Badge> : <Badge tone="warn">In progress</Badge>}<Link href="/finance" className="btn btn-sm">← Finance</Link></div>} />

      {/* Account + month pickers */}
      <div className="flex flex-wrap gap-2 mb-3">
        {cashAccts.map((a) => (
          <Link key={a.id} href={`/finance/reconcile?account=${a.id}&period=${period}`} className="btn btn-sm" style={a.id === accountId ? { background: "var(--surface)", borderColor: "var(--brand)" } : undefined}>{a.code} {a.name}</Link>
        ))}
      </div>
      <form action="/finance/reconcile" method="get" className="flex items-end gap-2 mb-5">
        <input type="hidden" name="account" value={accountId} />
        <Field label="Reconciliation month"><input type="month" name="period" defaultValue={period} className="input" /></Field>
        <div className="pb-0.5"><button className="btn" type="submit">Go</button></div>
      </form>

      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Cash book balance" value={money(rec.ledgerClosing, c)} sub="per ledger, month-end" />
        <Stat label="Statement closing" value={rec.statementClosing === null ? "—" : money(rec.statementClosing, c)} sub="as per bank" />
        <Stat label="Adjusted bank" value={rec.adjustedBank === null ? "—" : money(rec.adjustedBank, c)} sub="statement ± reconciling items" />
        <Stat label="Difference" value={rec.difference === null ? "—" : money(rec.difference, c)} sub={reconciled ? "reconciled" : "should be zero"} tone={rec.difference === 0 ? "ok" : "danger"} />
      </div>

      {/* Reconciliation statement */}
      <SectionTitle>Reconciliation statement</SectionTitle>
      <div className="card overflow-x-auto mb-6">
        <table className="w-full text-sm">
          <tbody>
            <tr><td className="td">Balance as per bank statement</td><td className="td text-right tabular-nums">{rec.statementClosing === null ? "— (enter below)" : money(rec.statementClosing, c)}</td></tr>
            <tr><td className="td">Add: deposits in transit (uncleared receipts)</td><td className="td text-right tabular-nums">{money(rec.depositsInTransit, c)}</td></tr>
            <tr><td className="td">Less: outstanding payments (uncleared vouchers)</td><td className="td text-right tabular-nums">({money(rec.outstandingPayments, c)})</td></tr>
            <tr style={{ fontWeight: 700 }}><td className="td">Adjusted bank balance</td><td className="td text-right tabular-nums">{rec.adjustedBank === null ? "—" : money(rec.adjustedBank, c)}</td></tr>
            <tr style={{ fontWeight: 700 }}><td className="td">Balance as per cash book (ledger)</td><td className="td text-right tabular-nums">{money(rec.ledgerClosing, c)}</td></tr>
            <tr style={{ fontWeight: 700 }}><td className="td">Difference</td><td className="td text-right tabular-nums" style={{ color: rec.difference === 0 ? "var(--ok)" : "var(--danger)" }}>{rec.difference === null ? "—" : money(rec.difference, c)}</td></tr>
          </tbody>
        </table>
      </div>

      {/* Bank statement closing input */}
      {!locked && (
        <form action={saveBankRecAction} className="card p-4 grid sm:grid-cols-3 gap-3 items-end mb-6">
          <input type="hidden" name="accountId" value={accountId} /><input type="hidden" name="period" value={period} />
          <Field label="Bank statement closing balance"><input type="number" step="0.01" name="statementClosing" defaultValue={rec.statementClosing ?? ""} className="input" /></Field>
          <div className="sm:col-span-1"><Field label="Note (optional)"><input name="note" defaultValue={rec.note ?? ""} className="input" /></Field></div>
          <div><button className="btn btn-primary" type="submit">Save statement balance</button></div>
        </form>
      )}

      {/* This month's movements (entries via receipts / vouchers) */}
      <SectionTitle>Cash movements in {period} — tick each as it clears the bank</SectionTitle>
      {rec.movements.length === 0 ? <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>No cash movements posted to this account in {period}.</p> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Date</th><th className="th text-left">Source</th><th className="th text-left">Description</th><th className="th text-right">In</th><th className="th text-right">Out</th><th className="th" /></tr></thead>
            <tbody>{rec.movements.map((m) => <MovementRow key={m.lineId} m={m} />)}</tbody>
          </table>
        </div>
      )}

      {/* Items brought forward from previous months, still uncleared */}
      {rec.broughtForward.length > 0 && (<>
        <SectionTitle>Brought forward — uncleared from earlier months</SectionTitle>
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Date</th><th className="th text-left">Source</th><th className="th text-left">Description</th><th className="th text-right">In</th><th className="th text-right">Out</th><th className="th" /></tr></thead>
            <tbody>{rec.broughtForward.map((m) => <MovementRow key={m.lineId} m={m} />)}</tbody>
          </table>
        </div>
      </>)}

      {/* Finalise */}
      <div className="flex items-center gap-3">
        {locked
          ? <form action={finalizeBankRecAction}><input type="hidden" name="accountId" value={accountId} /><input type="hidden" name="period" value={period} /><input type="hidden" name="reopen" value="1" /><button className="btn" type="submit">Reopen month</button></form>
          : <form action={finalizeBankRecAction}><input type="hidden" name="accountId" value={accountId} /><input type="hidden" name="period" value={period} /><button className="btn btn-primary" type="submit" disabled={!reconciled}>Finalise {period}</button></form>}
        {!locked && !reconciled && <span className="text-xs" style={{ color: "var(--muted)" }}>Enter the statement balance and clear items until the difference is zero to finalise.</span>}
        {locked && <span className="text-xs" style={{ color: "var(--muted)" }}>This month is finalised. Reopen to make changes.</span>}
      </div>
    </div>
  );
}
