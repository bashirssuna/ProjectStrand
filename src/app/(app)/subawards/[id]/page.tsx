import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSubawardOrg } from "../_guard";
import { q } from "@/server/db";
import { getSubaward, listPayments } from "@/server/services/subawards";
import { PageHeader, SectionTitle, Field, Stat, Empty, StatusBadge } from "@/components/ui";
import { money, fmtDate, dateInput } from "@/lib/format";
import { updateSubawardAction, deleteSubawardAction, addSubawardPaymentAction, deleteSubawardPaymentAction } from "@/app/actions";

export default async function SubawardDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; err?: string }> }) {
  const { id } = await params;
  const { orgId, orgName } = await requireSubawardOrg();
  const sp = await searchParams;
  const a = await getSubaward(id);
  if (!a) notFound();

  const payments = await listPayments(id);
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);
  const partners = await q<{ id: string; name: string }>(`SELECT id, name FROM collaborator WHERE org_id=$1 ORDER BY name`, [orgId]);
  const outstanding = a.amount - a.disbursed;

  return (
    <div className="max-w-5xl">
      <PageHeader title={a.granteeName} subtitle={`Sub-award · ${orgName}`} actions={<Link href="/subawards" className="btn btn-sm">← Sub-awards</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <Stat label="Committed" value={money(a.amount, a.currency)} />
        <Stat label="Disbursed" value={money(a.disbursed, a.currency)} sub={`${a.paymentCount} payment${a.paymentCount === 1 ? "" : "s"}`} />
        <Stat label="Outstanding" value={money(outstanding, a.currency)} tone={outstanding < 0 ? "danger" : undefined} />
        <div className="card p-3"><div className="label">Status</div><div className="mt-1"><StatusBadge status={a.status} /></div></div>
      </div>

      <SectionTitle>Sub-award details</SectionTitle>
      <form action={updateSubawardAction} className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
        <input type="hidden" name="subawardId" value={a.id} />
        <div className="sm:col-span-2"><Field label="Grantee organisation"><input name="granteeName" required defaultValue={a.granteeName} className="input" /></Field></div>
        <Field label="Link to partner"><select name="collaboratorId" defaultValue={a.collaboratorId ?? ""} className="select"><option value="">— none —</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <div className="sm:col-span-3"><Field label="Title / scope"><input name="title" required defaultValue={a.title} className="input" /></Field></div>
        <Field label="Funded from project"><select name="projectId" defaultValue={a.projectId ?? ""} className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select></Field>
        <Field label="Agreement reference"><input name="reference" defaultValue={a.reference ?? ""} className="input" /></Field>
        <Field label="Status"><select name="status" defaultValue={a.status} className="select"><option value="draft">Draft</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="completed">Completed</option><option value="closed">Closed</option></select></Field>
        <Field label="Amount"><input type="number" step="0.01" name="amount" defaultValue={a.amount} className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue={a.currency} className="input" /></Field>
        <div />
        <Field label="Start date"><input type="date" name="startDate" defaultValue={dateInput(a.startDate)} className="input" /></Field>
        <Field label="End date"><input type="date" name="endDate" defaultValue={dateInput(a.endDate)} className="input" /></Field>
        <div />
        <Field label="Contact person"><input name="contactName" defaultValue={a.contactName ?? ""} className="input" /></Field>
        <Field label="Contact email"><input name="contactEmail" defaultValue={a.contactEmail ?? ""} className="input" /></Field>
        <div />
        <div className="sm:col-span-3"><Field label="Activities the grantee will run"><textarea name="description" rows={3} defaultValue={a.description ?? ""} className="textarea" /></Field></div>
        <div className="sm:col-span-3"><Field label="Deliverables / milestones"><textarea name="deliverables" rows={3} defaultValue={a.deliverables ?? ""} className="textarea" /></Field></div>
        <div className="sm:col-span-3 flex justify-between">
          <button className="btn btn-primary" type="submit">Save changes</button>
        </div>
      </form>

      <SectionTitle>Disbursements</SectionTitle>
      {payments.length === 0 ? <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>No disbursements recorded yet.</p> : (
        <div className="card overflow-x-auto mb-3">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Date</th><th className="th text-right">Amount</th><th className="th text-left">Reference</th><th className="th text-left">Note</th><th className="th" /></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="td">{fmtDate(p.paidOn)}</td>
                  <td className="td text-right tabular-nums">{money(p.amount, a.currency)}</td>
                  <td className="td">{p.reference ?? "—"}</td>
                  <td className="td">{p.note ?? "—"}</td>
                  <td className="td text-right">
                    <form action={deleteSubawardPaymentAction}>
                      <input type="hidden" name="paymentId" value={p.id} />
                      <input type="hidden" name="subawardId" value={a.id} />
                      <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form action={addSubawardPaymentAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-end mb-6">
        <input type="hidden" name="subawardId" value={a.id} />
        <Field label="Date"><input type="date" name="paidOn" required className="input" /></Field>
        <Field label={`Amount (${a.currency})`}><input type="number" step="0.01" name="amount" required className="input" /></Field>
        <Field label="Reference"><input name="reference" className="input" /></Field>
        <Field label="Note"><input name="note" className="input" /></Field>
        <div className="sm:col-span-4 flex justify-end"><button className="btn btn-primary" type="submit">Record disbursement</button></div>
      </form>

      <SectionTitle>Danger zone</SectionTitle>
      <form action={deleteSubawardAction} className="card p-4 flex items-center justify-between">
        <input type="hidden" name="subawardId" value={a.id} />
        <span className="text-sm" style={{ color: "var(--muted)" }}>Delete this sub-award and all its disbursement records. This cannot be undone.</span>
        <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete sub-award</button>
      </form>
    </div>
  );
}
