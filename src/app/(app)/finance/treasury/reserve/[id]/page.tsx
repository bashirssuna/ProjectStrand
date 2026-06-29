import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFinanceOrg } from "../../../_guard";
import { q } from "@/server/db";
import { getFund, listFundMovements, RESERVE_MOVES } from "@/server/services/treasury";
import { PageHeader, SectionTitle, Field, Stat, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { recordReserveMovementAction, closeReserveFundAction, deleteReserveFundAction } from "@/app/actions";

const moveTone = (t: string) => (t === "utilization" ? "danger" : t === "allocation" ? "ok" : "muted");

export default async function ReserveFundPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const { id } = await params;
  const sp = await searchParams;
  const f = await getFund(orgId, id);
  if (!f) notFound();
  const [moves, projects] = await Promise.all([
    listFundMovements(orgId, id),
    q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]),
  ]);
  const ccy = f.currency;
  const closed = f.status === "closed";
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-4xl">
      <PageHeader title={f.name} subtitle={`${label(f.type)} reserve · ${orgName}`} actions={<Link href="/finance/treasury" className="btn btn-sm">← Treasury</Link>} />
      {sp.err === "insufficient" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Utilisation exceeds the reserve balance.</div>}
      {sp.err === "amount" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter a valid amount.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        {closed ? <Badge tone="muted">Closed</Badge> : <Badge tone="ok">Active</Badge>}
        {f.openedDate && <span className="text-sm" style={{ color: "var(--muted)" }}>Opened {fmtDate(f.openedDate)}</span>}
        <div className="ml-auto flex items-center gap-2">
          <form action={closeReserveFundAction}><input type="hidden" name="fundId" value={f.id} /><input type="hidden" name="reopen" value={closed ? "1" : "0"} /><button className="btn btn-sm" type="submit">{closed ? "Reopen" : "Close"}</button></form>
          <form action={deleteReserveFundAction}><input type="hidden" name="fundId" value={f.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
        <Stat label="Balance" value={money(f.balance, ccy)} tone="ok" />
        <Stat label="Target" value={f.targetAmount ? money(f.targetAmount, ccy) : "—"} />
        <Stat label="Purpose" value={f.purpose ?? "—"} />
      </div>

      <SectionTitle>Movements</SectionTitle>
      <div className="mt-2 mb-6">
        {moves.length === 0 ? <Empty title="No movements" hint="Record an allocation or utilisation below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Date</th><th className="th text-left">Type</th><th className="th text-left">Details</th><th className="th text-right">Amount</th><th className="th text-right">Balance</th></tr></thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.id}>
                    <td className="td whitespace-nowrap">{fmtDate(m.movementDate)}</td>
                    <td className="td"><Badge tone={moveTone(m.type)}>{label(m.type)}</Badge></td>
                    <td className="td"><div>{m.description || "—"}</div><div className="text-xs" style={{ color: "var(--muted)" }}>{[m.projectTitle, m.reference ? `Ref ${m.reference}` : null].filter(Boolean).join(" · ")}</div></td>
                    <td className="td text-right whitespace-nowrap" style={{ color: m.signed < 0 ? "var(--danger)" : "var(--ok)" }}>{m.signed < 0 ? "−" : "+"}{money(Math.abs(m.signed), ccy)}</td>
                    <td className="td text-right whitespace-nowrap">{money(m.balanceAfter, ccy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!closed && (
        <div className="card p-4">
          <SectionTitle>Record movement</SectionTitle>
          <form action={recordReserveMovementAction} className="grid sm:grid-cols-2 gap-3 mt-2">
            <input type="hidden" name="fundId" value={f.id} />
            <Field label="Type"><select name="type" className="select select-sm">{RESERVE_MOVES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
            <Field label="Amount *"><input name="amount" type="number" step="0.01" min="0" required className="input input-sm" /></Field>
            <Field label="Date"><input name="movementDate" type="date" defaultValue={today} className="input input-sm" /></Field>
            <Field label="Reference"><input name="reference" className="input input-sm" /></Field>
            <Field label="Project (optional)"><select name="projectId" className="select select-sm"><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}</select></Field>
            <div className="sm:col-span-2"><Field label="Description"><input name="description" className="input input-sm" /></Field></div>
            <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Record movement</button></div>
          </form>
          <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Allocations build the reserve; utilisations draw it down. Adjustments use the entered amount as-is.</p>
        </div>
      )}
    </div>
  );
}
