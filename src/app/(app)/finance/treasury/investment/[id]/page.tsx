import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFinanceOrg } from "../../../_guard";
import { getInvestment, listInvestmentMovements, INVESTMENT_MOVES } from "@/server/services/treasury";
import { PageHeader, SectionTitle, Field, Stat, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { recordInvestmentMovementAction, setInvestmentStatusAction, deleteInvestmentAction } from "@/app/actions";

const moveTone = (t: string) => (t === "interest" ? "ok" : t === "placement" ? "info" : t === "adjustment" ? "muted" : "warn");

export default async function InvestmentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const { id } = await params;
  const sp = await searchParams;
  const i = await getInvestment(orgId, id);
  if (!i) notFound();
  const moves = await listInvestmentMovements(orgId, id);
  const ccy = i.currency;
  const today = new Date().toISOString().slice(0, 10);
  const matured = i.maturityDate && i.maturityDate < today && i.status === "active";

  return (
    <div className="max-w-4xl">
      <PageHeader title={i.name} subtitle={`${label(i.instrumentType)}${i.institution ? ` · ${i.institution}` : ""} · ${orgName}`} actions={<Link href="/finance/treasury" className="btn btn-sm">← Treasury</Link>} />
      {sp.err === "insufficient" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Withdrawal exceeds the outstanding principal.</div>}
      {sp.err === "amount" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter a valid amount.</div>}
      {matured && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>This investment has passed its maturity date — record the maturity proceeds or update its status.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <Badge tone={i.status === "active" ? "ok" : i.status === "matured" ? "info" : "muted"}>{label(i.status)}</Badge>
        {i.interestRate != null && <span className="text-sm" style={{ color: "var(--muted)" }}>{i.interestRate}% p.a.</span>}
        {(i.placementDate || i.maturityDate) && <span className="text-sm" style={{ color: "var(--muted)" }}>{i.placementDate ? fmtDate(i.placementDate) : "…"} → {i.maturityDate ? fmtDate(i.maturityDate) : "…"}</span>}
        {i.reference && <span className="text-sm" style={{ color: "var(--muted)" }}>Ref: {i.reference}</span>}
        <div className="ml-auto flex items-center gap-2">
          <form action={setInvestmentStatusAction} className="flex items-center gap-2">
            <input type="hidden" name="investmentId" value={i.id} />
            <select name="status" defaultValue={i.status} className="select select-sm"><option value="active">Active</option><option value="matured">Matured</option><option value="liquidated">Liquidated</option></select>
            <button className="btn btn-sm" type="submit">Set status</button>
          </form>
          <form action={deleteInvestmentAction}><input type="hidden" name="investmentId" value={i.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Principal placed" value={money(i.principal, ccy)} />
        <Stat label="Outstanding" value={money(i.outstanding, ccy)} tone={i.outstanding ? undefined : "muted"} />
        <Stat label="Interest earned" value={money(i.interestEarned, ccy)} tone={i.interestEarned ? "ok" : undefined} />
        <Stat label="Expected at maturity" value={i.expectedValue ? money(i.expectedValue, ccy) : "—"} />
      </div>

      <SectionTitle>Movements</SectionTitle>
      <div className="mt-2 mb-6">
        {moves.length === 0 ? <Empty title="No movements" hint="Record interest, top-ups, withdrawals or maturity below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Date</th><th className="th text-left">Type</th><th className="th text-left">Details</th><th className="th text-right">Amount</th></tr></thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id}>
                    <td className="td whitespace-nowrap">{fmtDate(m.movementDate)}</td>
                    <td className="td"><Badge tone={moveTone(m.type)}>{label(m.type)}</Badge></td>
                    <td className="td"><div>{m.description || "—"}</div>{m.reference && <div className="text-xs" style={{ color: "var(--muted)" }}>Ref {m.reference}</div>}</td>
                    <td className="td text-right whitespace-nowrap">{money(m.amount, ccy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card p-4">
        <SectionTitle>Record movement</SectionTitle>
        <form action={recordInvestmentMovementAction} className="grid sm:grid-cols-2 gap-3 mt-2">
          <input type="hidden" name="investmentId" value={i.id} />
          <Field label="Type"><select name="type" className="select select-sm">{INVESTMENT_MOVES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
          <Field label="Amount *"><input name="amount" type="number" step="0.01" min="0" required className="input input-sm" /></Field>
          <Field label="Date"><input name="movementDate" type="date" defaultValue={today} className="input input-sm" /></Field>
          <Field label="Reference"><input name="reference" className="input input-sm" /></Field>
          <div className="sm:col-span-2"><Field label="Description"><input name="description" className="input input-sm" /></Field></div>
          <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Record movement</button></div>
        </form>
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Placements add to principal; interest is recorded as income; withdrawals and maturity reduce the outstanding principal. A maturity that clears the principal marks the investment matured.</p>
      </div>
    </div>
  );
}
