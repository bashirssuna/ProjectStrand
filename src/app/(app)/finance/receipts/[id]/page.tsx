import Link from "next/link";
import { redirect } from "next/navigation";
import { requireFinanceOrg } from "../../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Stat } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { currencyOptions } from "@/lib/currencies";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { editReceiptAction, deleteReceiptAction } from "@/app/actions";

type SP = { updated?: string; err?: string };

export default async function ReceiptDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { orgId } = await requireFinanceOrg();
  const base = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";

  const r = await one<{
    id: string; number: string; receiptDate: string; amount: number; currency: string; method: string;
    reference: string | null; note: string | null; reconciled: boolean; invoiceId: string | null; customerId: string | null;
    depositAccountId: string | null; incomeAccountId: string | null; journalEntryId: string | null;
    customer: string | null; invoiceNo: string | null;
  }>(
    `SELECT r.id, r.number, r.receipt_date AS "receiptDate", r.amount::float, r.currency, r.method, r.reference, r.note,
            r.reconciled, r.invoice_id AS "invoiceId", r.customer_id AS "customerId",
            r.deposit_account_id AS "depositAccountId", r.income_account_id AS "incomeAccountId", r.journal_entry_id AS "journalEntryId",
            c.name AS customer, i.number AS "invoiceNo"
       FROM receipt r LEFT JOIN finance_customer c ON c.id=r.customer_id LEFT JOIN invoice i ON i.id=r.invoice_id
      WHERE r.id=$1 AND r.org_id=$2`, [id, orgId]
  );
  if (!r) redirect("/finance/receipts");

  const cashAccts = await q<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='asset' AND (code LIKE '10%' OR name ILIKE '%cash%' OR name ILIKE '%bank%') AND is_active ORDER BY code`, [orgId]);
  const incomeAccts = await q<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='income' AND is_active ORDER BY code`, [orgId]);
  const openInvoices = await q<{ id: string; number: string; total: number; paid: number; currency: string }>(`SELECT id, number, total::float, amount_paid::float AS paid, currency FROM invoice WHERE org_id=$1 AND (status IN ('issued','part_paid') OR id=$2) ORDER BY created_at DESC`, [orgId, r.invoiceId ?? ""]);
  const customers = await q<{ id: string; name: string }>(`SELECT id, name FROM finance_customer WHERE org_id=$1 ORDER BY name`, [orgId]);

  return (
    <div className="max-w-3xl">
      <PageHeader title={`Receipt ${r.number}`} subtitle={`${money(r.amount, r.currency)} · ${fmtDate(r.receiptDate)}${r.customer ? ` · ${r.customer}` : ""}`}
        actions={<div className="flex gap-2"><a href={`/print/receipt/${r.id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨 Print</a><Link href="/finance/receipts" className="btn btn-sm">← All receipts</Link></div>} />

      {sp.updated && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Receipt updated and re-posted to the ledger.</div>}
      {sp.err === "reconciled" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>This receipt has been reconciled on a bank statement and can no longer be edited. Un-reconcile it first.</div>}
      {sp.err === "amount" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Amount must be positive.</div>}
      {sp.err && !["reconciled", "amount"].includes(sp.err) && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.err)}</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Amount" value={money(r.amount, r.currency)} />
        <Stat label="Method" value={label(r.method)} />
        <Stat label="Invoice" value={r.invoiceNo ?? "—"} />
        <Stat label="Posted" value={r.journalEntryId ? "✓ ledger" : "—"} />
      </div>

      {r.reconciled ? (
        <div className="card p-4 mb-4 text-sm" style={{ color: "var(--muted)" }}>
          <Badge tone="info">reconciled</Badge> This receipt is matched on a bank statement, so it can&apos;t be edited. You can still delete it (which reverses the ledger entry).
        </div>
      ) : (
        <>
          <SectionTitle>Edit receipt</SectionTitle>
          <form action={editReceiptAction} className="card p-4 grid sm:grid-cols-2 gap-3 mb-6">
            <input type="hidden" name="receiptId" value={r.id} />
            <Field label="Against invoice (optional)">
              <select name="invoiceId" className="select" defaultValue={r.invoiceId ?? ""}><option value="">— direct receipt (no invoice) —</option>{openInvoices.map((i) => <option key={i.id} value={i.id}>{i.number} · {money(i.total - i.paid, i.currency)} due</option>)}</select>
            </Field>
            <Field label="Customer (for direct receipts)">
              <select name="customerId" className="select" defaultValue={r.customerId ?? ""}><option value="">— none —</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            </Field>
            <Field label="Amount"><input type="number" step="0.01" name="amount" required defaultValue={r.amount} className="input" /></Field>
            <Field label="Currency"><select name="currency" defaultValue={r.currency || base} className="select">{currencyOptions(base).map((cc) => <option key={cc} value={cc}>{cc}</option>)}</select></Field>
            <Field label="Deposit to (cash/bank)">
              <select name="depositAccountId" required className="select" defaultValue={r.depositAccountId ?? ""}><option value="">— choose —</option>{cashAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
            </Field>
            <Field label="Income account (direct receipts)">
              <select name="incomeAccountId" className="select" defaultValue={r.incomeAccountId ?? ""}><option value="">— default (Grant income) —</option>{incomeAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
            </Field>
            <Field label="Method"><select name="method" className="select" defaultValue={r.method}><option value="bank_transfer">Bank transfer</option><option value="mobile_money">Mobile money</option><option value="cheque">Cheque</option><option value="cash">Cash</option></select></Field>
            <Field label="Date"><input type="date" name="receiptDate" defaultValue={r.receiptDate.slice(0, 10)} className="input" /></Field>
            <Field label="Reference"><input name="reference" defaultValue={r.reference ?? ""} className="input" /></Field>
            <Field label="Note"><input name="note" defaultValue={r.note ?? ""} className="input" /></Field>
            <div className="sm:col-span-2 flex justify-end"><button className="btn btn-primary" type="submit">Save changes</button></div>
          </form>
        </>
      )}

      <form action={deleteReceiptAction}>
        <input type="hidden" name="receiptId" value={r.id} />
        <ConfirmSubmit message="Delete this receipt? Its ledger entry will be reversed and any invoice payment undone." className="btn" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete receipt</ConfirmSubmit>
        <span className="text-xs ml-2" style={{ color: "var(--muted)" }}>Reverses the ledger entry{r.invoiceId ? " and undoes the invoice payment" : ""}.</span>
      </form>
    </div>
  );
}
