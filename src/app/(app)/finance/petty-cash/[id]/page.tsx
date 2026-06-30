import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFinanceOrg } from "../../_guard";
import { q } from "@/server/db";
import { getAccount, listTxns, EXPENSE_CATEGORIES } from "@/server/services/pettycash";
import { PageHeader, SectionTitle, Field, Stat, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { recordPettyCashExpenseAction, replenishPettyCashAction, reconcilePettyCashAction, closePettyCashAccountAction, deletePettyCashAccountAction } from "@/app/actions";

const typeTone = (t: string) => (t === "expense" ? "danger" : t === "top_up" ? "ok" : "muted");

export default async function PettyCashAccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string; reconciled?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const { id } = await params;
  const sp = await searchParams;
  const a = await getAccount(orgId, id);
  if (!a) notFound();
  const [txns, projects, budgetLines] = await Promise.all([
    listTxns(orgId, id),
    q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]),
    a.projectId
      ? q<{ id: string; code: string; description: string }>(`SELECT bl.id, bl.code, bl.description FROM budget_line bl JOIN budget b ON b.id=bl.budget_id WHERE b.project_id=$1 ORDER BY bl.code`, [a.projectId])
      : Promise.resolve([] as { id: string; code: string; description: string }[]),
  ]);
  const ccy = a.currency;
  const closed = a.status === "closed";
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="max-w-4xl">
      <PageHeader title={a.name} subtitle={`Petty cash · ${orgName}`} actions={<><a href={`/print/petty-cash/${a.id}`} target="_blank" className="btn btn-sm">Print statement ↗</a><Link href="/finance/petty-cash" className="btn btn-sm">← Petty cash</Link></>} />
      {sp.err === "insufficient" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Disbursement exceeds the cash on hand. Replenish the float first.</div>}
      {sp.err === "amount" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter a valid amount.</div>}
      {sp.reconciled && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Reconciliation recorded.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        {closed ? <Badge tone="muted">Closed</Badge> : <Badge tone="ok">Active</Badge>}
        {a.projectTitle && <Badge tone="info">{a.projectTitle}</Badge>}
        {a.custodian && <span className="text-sm" style={{ color: "var(--muted)" }}>Custodian: {a.custodian}</span>}
        {a.openedDate && <span className="text-sm" style={{ color: "var(--muted)" }}>Opened {fmtDate(a.openedDate)}</span>}
        <div className="ml-auto flex items-center gap-2">
          <form action={closePettyCashAccountAction}><input type="hidden" name="accountId" value={a.id} /><input type="hidden" name="reopen" value={closed ? "1" : "0"} /><button className="btn btn-sm" type="submit">{closed ? "Reopen" : "Close"}</button></form>
          <form action={deletePettyCashAccountAction}><input type="hidden" name="accountId" value={a.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Float limit" value={money(a.floatLimit, ccy)} />
        <Stat label="Cash on hand" value={money(a.balance, ccy)} tone={a.floatLimit > 0 && a.balance < a.floatLimit * 0.2 ? "danger" : undefined} />
        <Stat label="Total disbursed" value={money(a.expensed, ccy)} />
        <Stat label="Replenishment due" value={money(a.replenishDue, ccy)} tone={a.replenishDue ? "warn" : undefined} />
      </div>

      <SectionTitle>Ledger</SectionTitle>
      <div className="mt-2 mb-6">
        {txns.length === 0 ? <Empty title="No transactions" hint="Record a disbursement or replenishment below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Date</th><th className="th text-left">Type</th><th className="th text-left">Details</th><th className="th text-right">Amount</th><th className="th text-right">Balance</th><th className="th" /></tr></thead>
              <tbody>
                {txns.map((t) => (
                  <tr key={t.id}>
                    <td className="td whitespace-nowrap">{fmtDate(t.txnDate)}</td>
                    <td className="td"><Badge tone={typeTone(t.type)}>{label(t.type)}</Badge></td>
                    <td className="td">
                      <div>{t.payee || t.description || (t.type === "top_up" ? "Replenishment" : "—")}</div>
                      <div className="text-xs" style={{ color: "var(--muted)" }}>{[t.category, t.projectTitle, t.reference ? `Ref ${t.reference}` : null].filter(Boolean).join(" · ")}</div>
                      {t.payee && t.description && <div className="text-xs" style={{ color: "var(--muted)" }}>{t.description}</div>}
                      {t.expenditureId && <span className="inline-block mt-1"><Badge tone="ok">→ Posted to budget{t.budgetLineCode ? ` · ${t.budgetLineCode}` : ""}</Badge></span>}
                    </td>
                    <td className="td text-right whitespace-nowrap" style={{ color: t.signed < 0 ? "var(--danger)" : "var(--ok)" }}>{t.signed < 0 ? "−" : "+"}{money(Math.abs(t.signed), ccy)}</td>
                    <td className="td text-right whitespace-nowrap">{money(t.balanceAfter, ccy)}</td>
                    <td className="td text-right">{t.fileKey && <a href={`/api/petty-cash-receipt/${t.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>📎</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!closed && (
        <div className="grid md:grid-cols-2 gap-5">
          <div className="card p-4">
            <SectionTitle>Record disbursement</SectionTitle>
            <form action={recordPettyCashExpenseAction} className="grid sm:grid-cols-2 gap-3 mt-2">
              <input type="hidden" name="accountId" value={a.id} />
              <Field label="Date"><input name="txnDate" type="date" defaultValue={today} className="input input-sm" /></Field>
              <Field label="Amount *"><input name="amount" type="number" step="0.01" min="0" required className="input input-sm" /></Field>
              <Field label="Payee"><input name="payee" className="input input-sm" /></Field>
              <Field label="Category"><select name="category" className="select select-sm"><option value="">—</option>{EXPENSE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
              <div className="sm:col-span-2"><Field label="Description"><input name="description" className="input input-sm" /></Field></div>
              <Field label="Reference / voucher"><input name="reference" className="input input-sm" /></Field>
              {a.projectId ? (
                budgetLines.length > 0 ? (
                  <Field label={`Budget line — posts to ${a.projectTitle}`}><select name="budgetLineId" className="select select-sm"><option value="">— record in petty cash only</option>{budgetLines.map((b) => <option key={b.id} value={b.id}>{b.code} — {b.description}</option>)}</select></Field>
                ) : (
                  <div className="self-end text-xs" style={{ color: "var(--muted)" }}>No budget lines in this project — disbursement is recorded in petty cash only.</div>
                )
              ) : (
                <Field label="Project (optional)"><select name="projectId" className="select select-sm"><option value="">—</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}</select></Field>
              )}
              <Field label="Receipt"><input name="file" type="file" className="input input-sm" /></Field>
              <label className="flex items-center gap-2 text-sm self-end"><input type="checkbox" name="approved" /> Approved</label>
              <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Record disbursement</button></div>
            </form>
          </div>

          <div className="space-y-5">
            <div className="card p-4">
              <SectionTitle>Replenish float</SectionTitle>
              <p className="text-xs mt-1 mb-2" style={{ color: "var(--muted)" }}>Restore the float toward its limit. Suggested: {money(a.replenishDue, ccy)}.</p>
              <form action={replenishPettyCashAction} className="grid sm:grid-cols-2 gap-3">
                <input type="hidden" name="accountId" value={a.id} />
                <Field label="Date"><input name="txnDate" type="date" defaultValue={today} className="input input-sm" /></Field>
                <Field label="Amount *"><input name="amount" type="number" step="0.01" min="0" defaultValue={a.replenishDue || ""} required className="input input-sm" /></Field>
                <div className="sm:col-span-2"><Field label="Reference"><input name="reference" className="input input-sm" /></Field></div>
                <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Replenish</button></div>
              </form>
            </div>

            <div className="card p-4">
              <SectionTitle>Reconcile (cash count)</SectionTitle>
              <p className="text-xs mt-1 mb-2" style={{ color: "var(--muted)" }}>Enter counted cash; any variance posts an adjustment. Book balance: {money(a.balance, ccy)}.</p>
              <form action={reconcilePettyCashAction} className="grid sm:grid-cols-2 gap-3">
                <input type="hidden" name="accountId" value={a.id} />
                <Field label="Date"><input name="txnDate" type="date" defaultValue={today} className="input input-sm" /></Field>
                <Field label="Counted cash *"><input name="counted" type="number" step="0.01" min="0" required className="input input-sm" /></Field>
                <div className="sm:col-span-2"><Field label="Note"><input name="note" className="input input-sm" placeholder="Reason for variance, if any" /></Field></div>
                <div className="sm:col-span-2"><button className="btn btn-sm" type="submit">Record count</button></div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
