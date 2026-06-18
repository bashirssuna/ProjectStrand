import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { createStandaloneVoucherAction } from "@/app/actions";
import { budgetLineOptions } from "@/server/services/payment-slips";

export default async function VouchersPage({ searchParams }: { searchParams: Promise<{ created?: string; err?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";

  const vouchers = await q<{ id: string; number: string; voucherDate: string | null; project: string | null; payee: string; amount: number; method: string; purpose: string | null; status: string; standalone: boolean }>(
    `SELECT pv.id, pv.number, pv.voucher_date AS "voucherDate", p.code AS project, pv.payee, pv.amount::float, pv.method, pv.purpose, COALESCE(pv.status,'prepared') AS status,
            (pv.requisition_id IS NULL) AS standalone
     FROM payment_voucher pv LEFT JOIN project p ON p.id=pv.project_id
     WHERE pv.org_id=$1 ORDER BY pv.voucher_date DESC NULLS LAST, pv.created_at DESC LIMIT 100`, [orgId]
  );
  const cashAccts = await q<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='asset' AND (code LIKE '10%' OR name ILIKE '%cash%' OR name ILIKE '%bank%') AND is_active ORDER BY code`, [orgId]
  );
  const expenseAccts = await q<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='expense' AND is_active ORDER BY code`, [orgId]
  );
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]);
  const budgetLines = await budgetLineOptions(orgId);
  const ready = cashAccts.length > 0 && expenseAccts.length > 0;

  return (
    <div className="max-w-4xl">
      <PageHeader title="Payment vouchers" subtitle="Record payments out — these post to the ledger and feed bank reconciliation"
        actions={<div className="flex gap-2"><Link href="/finance/reconcile" className="btn btn-sm">Reconcile →</Link><Link href="/finance" className="btn btn-sm">← Finance</Link></div>} />

      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Voucher {sp.created} recorded and posted to the ledger.</div>}
      {sp.err === "invalid" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter a payee, a positive amount, and both the cash/bank and expense accounts.</div>}
      {sp.err && sp.err !== "invalid" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.err)}</div>}

      <SectionTitle>Vouchers</SectionTitle>
      {vouchers.length === 0 ? <Empty title="No payment vouchers yet" hint="Record one below — it posts a payment to the ledger." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Voucher no.</th><th className="th text-left">Date</th><th className="th text-left">Project</th><th className="th text-left">Payee</th><th className="th text-left">Description</th><th className="th text-right">Amount</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {vouchers.map((v) => (
                <tr key={v.id}>
                  <td className="td font-mono text-xs">{v.number}</td>
                  <td className="td whitespace-nowrap">{v.voucherDate ? fmtDate(v.voucherDate) : "—"}</td>
                  <td className="td font-mono text-xs">{v.project ?? "—"}</td>
                  <td className="td">{v.payee}</td>
                  <td className="td">{v.purpose ?? "—"}</td>
                  <td className="td text-right tabular-nums">{money(v.amount, c)}</td>
                  <td className="td"><Badge tone={v.status === "paid" || v.status === "approved" ? "ok" : "muted"}>{label(v.status)}</Badge></td>
                  <td className="td text-right"><a href={`/print/voucher/${v.id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Record a payment voucher</SectionTitle>
      {!ready ? (
        <div className="card p-4 text-sm" style={{ color: "var(--muted)" }}>
          You need at least one cash/bank account and one expense account in the <Link href="/finance/accounts" className="hover:underline" style={{ color: "var(--brand)" }}>chart of accounts</Link> before recording vouchers.
        </div>
      ) : (
        <form action={createStandaloneVoucherAction} className="card p-4 grid sm:grid-cols-3 gap-3">
          <Field label="Voucher date"><input type="date" name="voucherDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
          <Field label="Payee"><input name="payee" required className="input" placeholder="Who is being paid" /></Field>
          <Field label="Amount"><input type="number" step="0.01" name="amount" required className="input" /></Field>
          <Field label="Project (optional)"><select name="projectId" className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select></Field>
          <Field label="Pay from (cash/bank)"><select name="accountId" required className="select"><option value="">— choose —</option>{cashAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
          <Field label="Expense account"><select name="expenseAccountId" required className="select"><option value="">— choose —</option>{expenseAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
          {budgetLines.length > 0 && (
            <div className="sm:col-span-3"><Field label="Budget line (optional — deducts from the project budget)">
              <select name="budgetLineId" className="select"><option value="">— none —</option>
                {budgetLines.map((l) => <option key={l.id} value={l.id}>{l.projectCode} · {l.code} — {l.description} (remaining {money(l.remaining, l.currency)})</option>)}
              </select>
            </Field></div>
          )}
          <Field label="Payment method"><select name="method" className="select"><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option><option value="cash">Cash</option><option value="mobile_money">Mobile money</option></select></Field>
          <Field label="Reference / cheque no."><input name="reference" className="input" /></Field>
          <div className="sm:col-span-3"><Field label="Description"><input name="purpose" className="input" placeholder="What the payment is for" /></Field></div>
          <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Record &amp; post voucher</button></div>
        </form>
      )}
    </div>
  );
}
