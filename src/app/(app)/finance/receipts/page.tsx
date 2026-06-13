import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { createReceiptAction } from "@/app/actions";

export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<{ created?: string; err?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const base = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";

  const cashAccts = await q<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='asset' AND (code LIKE '10%' OR name ILIKE '%cash%' OR name ILIKE '%bank%') AND is_active ORDER BY code`, [orgId]);
  const incomeAccts = await q<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='income' AND is_active ORDER BY code`, [orgId]);
  const openInvoices = await q<{ id: string; number: string; total: number; paid: number; currency: string }>(`SELECT id, number, total::float, amount_paid::float AS paid, currency FROM invoice WHERE org_id=$1 AND status IN ('issued','part_paid') ORDER BY created_at DESC`, [orgId]);
  const customers = await q<{ id: string; name: string }>(`SELECT id, name FROM finance_customer WHERE org_id=$1 ORDER BY name`, [orgId]);
  const receipts = await q<{ id: string; number: string; receiptDate: string; amount: number; currency: string; method: string; customer: string | null; invoiceNo: string | null }>(
    `SELECT r.id, r.number, r.receipt_date AS "receiptDate", r.amount::float, r.currency, r.method,
            c.name AS customer, i.number AS "invoiceNo"
     FROM receipt r LEFT JOIN finance_customer c ON c.id=r.customer_id LEFT JOIN invoice i ON i.id=r.invoice_id
     WHERE r.org_id=$1 ORDER BY r.created_at DESC`, [orgId]
  );

  return (
    <div className="max-w-5xl">
      <PageHeader title="Receipts" subtitle="Record money received and settle invoices" actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Receipt {sp.created} recorded and posted to the ledger.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{sp.err === "amount" ? "Amount must be positive." : decodeURIComponent(sp.err)}</div>}

      <SectionTitle>Receipts</SectionTitle>
      {receipts.length === 0 ? <Empty title="No receipts yet" hint="Record one below; it posts a debit to cash/bank automatically." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Number</th><th className="th text-left">Date</th><th className="th text-left">From</th><th className="th text-left">Method</th><th className="th text-left">Invoice</th><th className="th text-right">Amount</th><th className="th" /></tr></thead>
            <tbody>
              {receipts.map((r) => (
                <tr key={r.id}>
                  <td className="td font-mono text-xs">{r.number}</td>
                  <td className="td whitespace-nowrap">{fmtDate(r.receiptDate)}</td>
                  <td className="td">{r.customer ?? "—"}</td>
                  <td className="td">{label(r.method)}</td>
                  <td className="td font-mono text-xs">{r.invoiceNo ?? "—"}</td>
                  <td className="td text-right tabular-nums">{money(r.amount, r.currency)}</td>
                  <td className="td text-right"><a href={`/print/receipt/${r.id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Record a receipt</SectionTitle>
      <form action={createReceiptAction} className="card p-4 grid sm:grid-cols-2 gap-3">
        <Field label="Against invoice (optional)">
          <select name="invoiceId" className="select"><option value="">— direct receipt (no invoice) —</option>{openInvoices.map((i) => <option key={i.id} value={i.id}>{i.number} · {money(i.total - i.paid, i.currency)} due</option>)}</select>
        </Field>
        <Field label="Customer (for direct receipts)">
          <select name="customerId" className="select"><option value="">— none —</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </Field>
        <Field label="Amount"><input type="number" step="0.01" name="amount" required className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue={base} className="input" /></Field>
        <Field label="Deposit to (cash/bank)">
          <select name="depositAccountId" required className="select"><option value="">— choose —</option>{cashAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
        </Field>
        <Field label="Income account (direct receipts)">
          <select name="incomeAccountId" className="select"><option value="">— default (Grant income) —</option>{incomeAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
        </Field>
        <Field label="Method">
          <select name="method" className="select"><option value="bank_transfer">Bank transfer</option><option value="mobile_money">Mobile money</option><option value="cheque">Cheque</option><option value="cash">Cash</option></select>
        </Field>
        <Field label="Date"><input type="date" name="receiptDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
        <Field label="Reference"><input name="reference" className="input" placeholder="Txn / cheque no." /></Field>
        <Field label="Note"><input name="note" className="input" /></Field>
        <div className="sm:col-span-2 flex justify-end"><button className="btn btn-primary" type="submit">Record &amp; post receipt</button></div>
      </form>
    </div>
  );
}
