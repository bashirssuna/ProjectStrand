import Link from "next/link";
import { requireFinanceOrg } from "../../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, StatusBadge, Empty, Badge } from "@/components/ui";
import { money, fmtDate, dateInput } from "@/lib/format";
import { currencyOptions } from "@/lib/currencies";
import { updateInvoiceAction, addInvoiceLineAction, deleteInvoiceLineAction, issueInvoiceAction, voidInvoiceAction } from "@/app/actions";

export default async function InvoiceDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; created?: string; line?: string; err?: string }> }) {
  const { orgId } = await requireFinanceOrg();
  const { id } = await params;
  const sp = await searchParams;
  const base = (await one<{ b: string }>(`SELECT base_currency b FROM organization WHERE id=$1`, [orgId]))?.b ?? "USD";

  const inv = await one<{
    id: string; number: string; status: string; invoiceDate: string; dueDate: string | null; currency: string;
    customerId: string | null; projectId: string | null; incomeAccountId: string | null; description: string | null;
    awardNumber: string | null; awardee: string | null; signatoryName: string | null; signatoryTitle: string | null;
    total: number; amountPaid: number;
  }>(
    `SELECT id, number, status, invoice_date AS "invoiceDate", due_date AS "dueDate", currency,
            customer_id AS "customerId", project_id AS "projectId", income_account_id AS "incomeAccountId", description,
            award_number AS "awardNumber", awardee, signatory_name AS "signatoryName", signatory_title AS "signatoryTitle",
            total::float, amount_paid::float AS "amountPaid"
     FROM invoice WHERE id=$1 AND org_id=$2`, [id, orgId]
  );
  if (!inv) return <Empty title="Invoice not found" hint="It may have been removed." />;

  const lines = await q<{ id: string; description: string; quantity: number; unitPrice: number; amount: number }>(
    `SELECT id, description, quantity::float, unit_price::float AS "unitPrice", amount::float FROM invoice_line WHERE invoice_id=$1 ORDER BY id`, [id]
  );
  const customers = await q<{ id: string; name: string }>(`SELECT id, name FROM finance_customer WHERE org_id=$1 ORDER BY name`, [orgId]);
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]);
  const incomeAccts = await q<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='income' AND is_active ORDER BY code`, [orgId]);
  const isDraft = inv.status === "draft";

  return (
    <div className="max-w-3xl">
      <PageHeader title={`Invoice ${inv.number}`} subtitle={isDraft ? "Draft — edit freely, then issue" : "Issued — locked for audit"}
        actions={<div className="flex gap-2 items-center">
          <StatusBadge status={inv.status} />
          <a href={`/print/invoice/${inv.id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨 Print / PDF</a>
          <Link href="/finance/invoices" className="btn btn-sm">← Invoices</Link>
        </div>} />

      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Invoice created as a draft. Edit the details below, add line items, then issue it.</div>}
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.line === "added" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Line added.</div>}
      {sp.line === "removed" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Line removed.</div>}
      {sp.err === "locked" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>This invoice is issued and can no longer be edited.</div>}

      {!isDraft && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--muted)" }}>This invoice has been issued, so its details are locked. Print it above, or void it to correct an error.</div>}

      {/* Header / letter details */}
      <SectionTitle>Invoice & grantor details</SectionTitle>
      <form action={updateInvoiceAction} className="card p-4 grid sm:grid-cols-2 gap-3 mb-6">
        <input type="hidden" name="invoiceId" value={inv.id} />
        <Field label="Bill to (grantor)">
          <select name="customerId" disabled={!isDraft} className="select" defaultValue={inv.customerId ?? ""}><option value="">— none —</option>{customers.map((cst) => <option key={cst.id} value={cst.id}>{cst.name}</option>)}</select>
        </Field>
        <Field label="Project (optional)">
          <select name="projectId" disabled={!isDraft} className="select" defaultValue={inv.projectId ?? ""}><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select>
        </Field>
        <Field label="Award / grant number"><input name="awardNumber" disabled={!isDraft} defaultValue={inv.awardNumber ?? ""} className="input" placeholder="e.g. 1R01AI123456-01" /></Field>
        <Field label="Awardee"><input name="awardee" disabled={!isDraft} defaultValue={inv.awardee ?? ""} className="input" placeholder="Name of the awardee institution" /></Field>
        <Field label="Invoice date"><input type="date" name="invoiceDate" disabled={!isDraft} defaultValue={dateInput(inv.invoiceDate)} className="input" /></Field>
        <Field label="Due date"><input type="date" name="dueDate" disabled={!isDraft} defaultValue={dateInput(inv.dueDate)} className="input" /></Field>
        <Field label="Currency"><select name="currency" disabled={!isDraft} className="select" defaultValue={inv.currency}>{currencyOptions(inv.currency).map((cc) => <option key={cc} value={cc}>{cc}</option>)}</select></Field>
        <Field label="Income account"><select name="incomeAccountId" disabled={!isDraft} className="select" defaultValue={inv.incomeAccountId ?? ""}><option value="">— default (Grant income) —</option>{incomeAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
        <div className="sm:col-span-2"><Field label="Header note / description"><input name="description" disabled={!isDraft} defaultValue={inv.description ?? ""} className="input" placeholder="Appears under the invoice title" /></Field></div>
        <Field label="Signatory name"><input name="signatoryName" disabled={!isDraft} defaultValue={inv.signatoryName ?? ""} className="input" placeholder="Who signs the invoice" /></Field>
        <Field label="Signatory title"><input name="signatoryTitle" disabled={!isDraft} defaultValue={inv.signatoryTitle ?? ""} className="input" placeholder="e.g. Finance Manager" /></Field>
        {isDraft && <div className="sm:col-span-2 flex justify-end"><button className="btn btn-primary" type="submit">Save details</button></div>}
      </form>

      {/* Line items */}
      <SectionTitle>Line items</SectionTitle>
      <div className="card overflow-x-auto mb-3">
        <table className="w-full text-sm">
          <thead><tr><th className="th text-left">#</th><th className="th text-left">Description</th><th className="th text-right">Qty</th><th className="th text-right">Unit price</th><th className="th text-right">Amount</th>{isDraft && <th className="th" />}</tr></thead>
          <tbody>
            {lines.length === 0 ? <tr><td className="td" colSpan={isDraft ? 6 : 5} style={{ color: "var(--muted)" }}>No line items yet.</td></tr>
              : lines.map((l, i) => (
                <tr key={l.id}>
                  <td className="td">{i + 1}</td>
                  <td className="td">{l.description}</td>
                  <td className="td text-right tabular-nums">{l.quantity}</td>
                  <td className="td text-right tabular-nums">{money(l.unitPrice, inv.currency)}</td>
                  <td className="td text-right tabular-nums">{money(l.amount, inv.currency)}</td>
                  {isDraft && <td className="td text-right">
                    <form action={deleteInvoiceLineAction}><input type="hidden" name="invoiceId" value={inv.id} /><input type="hidden" name="lineId" value={l.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Remove</button></form>
                  </td>}
                </tr>
              ))}
            <tr style={{ fontWeight: 700 }}><td className="td" colSpan={4}>Total</td><td className="td text-right tabular-nums">{money(inv.total, inv.currency)}</td>{isDraft && <td className="td" />}</tr>
          </tbody>
        </table>
      </div>

      {isDraft && (
        <form action={addInvoiceLineAction} className="card p-4 grid sm:grid-cols-4 gap-3 mb-6">
          <input type="hidden" name="invoiceId" value={inv.id} />
          <div className="sm:col-span-2"><Field label="Description"><input name="description" required className="input" /></Field></div>
          <Field label="Quantity"><input type="number" step="0.01" name="quantity" defaultValue={1} className="input" /></Field>
          <Field label="Unit price"><input type="number" step="0.01" name="unitPrice" required className="input" /></Field>
          <div className="sm:col-span-4 flex justify-end"><button className="btn" type="submit">+ Add line</button></div>
        </form>
      )}

      {/* Issue / void */}
      <div className="flex items-center gap-2">
        {isDraft
          ? <form action={issueInvoiceAction}><input type="hidden" name="invoiceId" value={inv.id} /><button className="btn btn-primary" type="submit">Issue invoice</button></form>
          : inv.status !== "void" && inv.amountPaid === 0 && <form action={voidInvoiceAction}><input type="hidden" name="invoiceId" value={inv.id} /><button className="btn" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Void invoice</button></form>}
        {isDraft && <span className="text-xs" style={{ color: "var(--muted)" }}>Issuing posts the receivable to the ledger and locks the invoice.</span>}
      </div>
    </div>
  );
}
