import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, StatusBadge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { currencyOptions } from "@/lib/currencies";
import { createInvoiceAction, issueInvoiceAction, voidInvoiceAction, addCustomerAction } from "@/app/actions";

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<{ created?: string; issued?: string; voided?: string; cust?: string; err?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;
  const base = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";

  const customers = await q<{ id: string; name: string }>(`SELECT id, name FROM finance_customer WHERE org_id=$1 ORDER BY name`, [orgId]);
  const incomeAccts = await q<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='income' AND is_active ORDER BY code`, [orgId]);
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);
  const invoices = await q<{ id: string; number: string; invoiceDate: string; customer: string | null; currency: string; total: number; amountPaid: number; status: string }>(
    `SELECT i.id, i.number, i.invoice_date AS "invoiceDate", c.name AS customer, i.currency, i.total::float, i.amount_paid::float AS "amountPaid", i.status
     FROM invoice i LEFT JOIN finance_customer c ON c.id=i.customer_id WHERE i.org_id=$1 ORDER BY i.created_at DESC`, [orgId]
  );

  return (
    <div className="max-w-5xl">
      <PageHeader title="Invoices & income" subtitle="Raise invoices to funders and track receivables" actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Invoice {sp.created} created as a draft. Issue it to post the receivable.</div>}
      {sp.issued && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Invoice issued — receivable posted to the ledger.</div>}
      {sp.voided && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Invoice voided and its posting reversed.</div>}
      {sp.cust && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Customer added.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{sp.err === "amount" ? "Amount must be positive." : sp.err === "cust" ? "Customer name required." : decodeURIComponent(sp.err)}</div>}

      <SectionTitle>Invoices</SectionTitle>
      {invoices.length === 0 ? <Empty title="No invoices yet" hint="Create one below; issuing it posts a receivable to the ledger." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Number</th><th className="th text-left">Date</th><th className="th text-left">Customer</th><th className="th text-left">Status</th><th className="th text-right">Total</th><th className="th text-right">Paid</th><th className="th" /></tr></thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td className="td font-mono text-xs"><Link href={`/finance/invoices/${i.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{i.number}</Link></td>
                  <td className="td whitespace-nowrap">{fmtDate(i.invoiceDate)}</td>
                  <td className="td">{i.customer ?? "—"}</td>
                  <td className="td"><StatusBadge status={i.status} /></td>
                  <td className="td text-right tabular-nums">{money(i.total, i.currency)}</td>
                  <td className="td text-right tabular-nums">{money(i.amountPaid, i.currency)}</td>
                  <td className="td text-right whitespace-nowrap">
                    <div className="flex gap-1 justify-end">
                      {i.status === "draft" && <Link href={`/finance/invoices/${i.id}`} className="btn btn-sm">Edit</Link>}
                      {i.status === "draft" && (
                        <form action={issueInvoiceAction}><input type="hidden" name="invoiceId" value={i.id} /><button className="btn btn-sm btn-primary" type="submit">Issue</button></form>
                      )}
                      {(i.status === "draft" || i.status === "issued") && i.amountPaid === 0 && (
                        <form action={voidInvoiceAction}><input type="hidden" name="invoiceId" value={i.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Void</button></form>
                      )}
                      <a href={`/print/invoice/${i.id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨</a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        <div>
          <SectionTitle>New invoice</SectionTitle>
          <form action={createInvoiceAction} className="card p-4 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Customer">
                <select name="customerId" className="select"><option value="">— none —</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
              </Field>
              <Field label="Project (optional)">
                <select name="projectId" className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select>
              </Field>
            </div>
            <Field label="Description"><input name="description" required className="input" placeholder="e.g. Milestone 1 deliverable" /></Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Quantity"><input type="number" step="0.01" name="quantity" defaultValue={1} className="input" /></Field>
              <Field label="Unit price"><input type="number" step="0.01" name="unitPrice" required className="input" /></Field>
              <Field label="Currency"><select name="currency" defaultValue={base} className="select">{currencyOptions(base).map((cc) => <option key={cc} value={cc}>{cc}</option>)}</select></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Invoice date"><input type="date" name="invoiceDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
              <Field label="Due date"><input type="date" name="dueDate" className="input" /></Field>
            </div>
            <Field label="Income account">
              <select name="incomeAccountId" className="select"><option value="">— default (Grant income) —</option>{incomeAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select>
            </Field>
            <button className="btn btn-primary" type="submit">Create draft invoice</button>
          </form>
        </div>

        <div>
          <SectionTitle>Add a customer / funder</SectionTitle>
          <form action={addCustomerAction} className="card p-4 space-y-3">
            <Field label="Name (organisation)"><input name="name" required className="input" placeholder="e.g. NIH, Gates Foundation" /></Field>
            <Field label="Attention (contact person)"><input name="contactName" className="input" placeholder="e.g. Prof. Jane Doe" /></Field>
            <Field label="Contact title"><input name="contactTitle" className="input" placeholder="e.g. Grants Officer" /></Field>
            <Field label="Email"><input name="email" className="input" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tel"><input name="phone" className="input" /></Field>
              <Field label="Fax"><input name="fax" className="input" /></Field>
            </div>
            <Field label="Address"><input name="address" className="input" /></Field>
            <button className="btn btn-primary" type="submit">Add customer</button>
          </form>
        </div>
      </div>
    </div>
  );
}
