import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireProcOrg } from "../../_guard";
import { isModuleEnabled } from "@/server/modules";
import { q, one } from "@/server/db";
import { contractMilestones, contractPayments, contractAppraisals, appraisalOverall, contractPaidTotal } from "@/server/services/contracts";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { money, fmtDate, pct } from "@/lib/format";
import { label } from "@/lib/enums";
import { currencyOptions } from "@/lib/currencies";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { updateContractAction, setContractStatusAction, deleteContractAction, addContractMilestoneAction, updateContractMilestoneAction, addContractPaymentAction, addContractAppraisalAction, deleteContractItemAction } from "@/app/actions";

const STATUSES = ["draft", "active", "suspended", "completed", "terminated"];
const MS_STATUSES = ["pending", "delivered", "accepted", "delayed"];

function DelBtn({ contractId, kind, id }: { contractId: string; kind: string; id: string }) {
  return (
    <form action={deleteContractItemAction} className="inline"><input type="hidden" name="contractId" value={contractId} /><input type="hidden" name="kind" value={kind} /><input type="hidden" name="itemId" value={id} />
      <ConfirmSubmit message="Remove this entry?"><button className="text-xs hover:underline" type="submit" style={{ color: "var(--danger)" }}>remove</button></ConfirmSubmit>
    </form>
  );
}

export default async function ContractDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const { orgId } = await requireProcOrg();
  if (!(await isModuleEnabled(orgId, "public_procurement"))) redirect("/procurement");
  const sp = await searchParams;

  const c = await one<{
    id: string; reference: string | null; title: string; status: string; contractValue: number; currency: string | null; vendorId: string | null; providerName: string | null; vendorName: string | null;
    tenderId: string | null; tenderRef: string | null; startDate: string | null; endDate: string | null; signedDate: string | null; scope: string | null;
  }>(
    `SELECT c.id, c.reference, c.title, c.status, c.contract_value::float8 AS "contractValue", c.currency, c.vendor_id AS "vendorId", c.provider_name AS "providerName", v.name AS "vendorName",
            c.tender_id AS "tenderId", t.reference AS "tenderRef", c.start_date::text AS "startDate", c.end_date::text AS "endDate", c.signed_date::text AS "signedDate", c.scope
     FROM contract c LEFT JOIN vendor v ON v.id=c.vendor_id LEFT JOIN tender t ON t.id=c.tender_id WHERE c.id=$1 AND c.org_id=$2`, [id, orgId]
  );
  if (!c) notFound();
  const [milestones, payments, appraisals, paid, vendors] = await Promise.all([
    contractMilestones(id), contractPayments(id), contractAppraisals(id), contractPaidTotal(id),
    q<{ id: string; name: string }>(`SELECT id, name FROM vendor WHERE org_id=$1 ORDER BY name`, [orgId]),
  ]);
  const cur = c.currency ?? "USD";
  const balance = c.contractValue - paid;
  const paidPct = c.contractValue > 0 ? Math.min(100, (paid / c.contractValue) * 100) : 0;
  const msDone = milestones.filter((m) => ["delivered", "accepted"].includes(m.status)).length;
  const overalls = appraisals.map((a) => appraisalOverall(a)).filter((x): x is number => x != null);
  const rating = overalls.length ? Math.round((overalls.reduce((s, x) => s + x, 0) / overalls.length) * 10) / 10 : null;
  const notes: Record<string, string> = { milestone: "Milestone added.", payment: "Payment recorded.", appraisal: "Appraisal recorded." };

  return (
    <div className="max-w-4xl">
      <PageHeader title={`${c.reference ? c.reference + " — " : ""}${c.title}`} subtitle={`Contract · ${c.vendorName ?? c.providerName ?? "provider"}`}
        actions={<div className="flex gap-2">
          <form action={deleteContractAction} className="inline"><input type="hidden" name="contractId" value={c.id} /><ConfirmSubmit message="Delete this contract and all its milestones, payments and appraisals?"><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button></ConfirmSubmit></form>
          <Link href="/procurement/contracts" className="btn btn-sm">← Contracts</Link>
        </div>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Contract created.</div>}
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.added && notes[sp.added] && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>{notes[sp.added]}</div>}

      {/* Status + headline */}
      <div className="card p-4 mb-5">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <StatusBadge status={c.status} />
          <form action={setContractStatusAction} className="flex items-center gap-2"><input type="hidden" name="contractId" value={c.id} />
            <select name="status" defaultValue={c.status} className="select" style={{ padding: "4px 8px", fontSize: 13 }}>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
            <button className="btn btn-sm" type="submit">Set status</button>
          </form>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <Stat label="Value" value={money(c.contractValue, cur)} />
          <Stat label="Paid" value={money(paid, cur)} sub={pct(paidPct)} />
          <Stat label="Balance" value={money(balance, cur)} tone={balance < 0 ? "danger" : undefined} />
          <Stat label="Delivery" value={milestones.length ? `${msDone}/${milestones.length}` : "—"} />
          <Stat label="Provider rating" value={rating != null ? `${rating} / 5` : "—"} />
        </div>
      </div>

      {/* Details */}
      <div className="card p-4 mb-5">
        <SectionTitle>Details</SectionTitle>
        <div className="grid sm:grid-cols-2 gap-y-1 text-sm">
          <div><span style={{ color: "var(--muted)" }}>Provider: </span>{c.vendorName ?? c.providerName ?? "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>From tender: </span>{c.tenderId ? <Link href={`/procurement/tenders/${c.tenderId}`} className="hover:underline" style={{ color: "var(--brand)" }}>{c.tenderRef ?? "tender"}</Link> : "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Period: </span>{c.startDate ? fmtDate(c.startDate) : "—"} → {c.endDate ? fmtDate(c.endDate) : "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Signed: </span>{c.signedDate ? fmtDate(c.signedDate) : "—"}</div>
          {c.scope && <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Scope: </span>{c.scope}</div>}
        </div>
      </div>

      {/* Milestones (delivery) */}
      <div className="card p-4 mb-5">
        <SectionTitle>Deliverables & milestones</SectionTitle>
        {milestones.length > 0 && (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Milestone</th><th className="th text-left">Due</th><th className="th text-right">Amount</th><th className="th text-left">Delivered</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>{milestones.map((m) => (
              <tr key={m.id}><td className="td">{m.name}</td><td className="td whitespace-nowrap">{m.dueDate ? fmtDate(m.dueDate) : "—"}</td><td className="td text-right tabular-nums">{m.amount != null ? money(m.amount, cur) : "—"}</td><td className="td whitespace-nowrap">{m.deliveredDate ? fmtDate(m.deliveredDate) : "—"}</td><td className="td"><StatusBadge status={m.status} /></td>
                <td className="td text-right">
                  <form action={updateContractMilestoneAction} className="inline-flex items-center gap-1 mr-2"><input type="hidden" name="contractId" value={c.id} /><input type="hidden" name="milestoneId" value={m.id} />
                    <select name="msStatus" defaultValue={m.status} className="select" style={{ padding: "2px 6px", fontSize: 12 }}>{MS_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
                    <button className="text-xs hover:underline" type="submit" style={{ color: "var(--brand)" }}>set</button>
                  </form>
                  <DelBtn contractId={c.id} kind="milestone" id={m.id} />
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <form action={addContractMilestoneAction} className="grid sm:grid-cols-5 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="contractId" value={c.id} />
          <Field label="Milestone"><input name="name" required className="input" placeholder="e.g. Delivery & installation" /></Field>
          <Field label="Due"><input type="date" name="dueDate" className="input" /></Field>
          <Field label="Amount"><input type="number" step="any" name="amount" className="input" /></Field>
          <Field label="Status"><select name="msStatus" defaultValue="pending" className="select">{MS_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
          <div><button className="btn btn-sm btn-primary" type="submit">Add</button></div>
        </form>
      </div>

      {/* Payments */}
      <div className="card p-4 mb-5">
        <SectionTitle>Payments</SectionTitle>
        {payments.length > 0 && (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Date</th><th className="th text-left">Reference</th><th className="th text-right">Amount</th><th className="th text-left">Note</th><th className="th" /></tr></thead>
            <tbody>{payments.map((p) => (
              <tr key={p.id}><td className="td whitespace-nowrap">{p.paymentDate ? fmtDate(p.paymentDate) : "—"}</td><td className="td">{p.reference ?? "—"}</td><td className="td text-right tabular-nums">{money(p.amount, p.currency ?? cur)}</td><td className="td">{p.note ?? ""}</td><td className="td text-right"><DelBtn contractId={c.id} kind="payment" id={p.id} /></td></tr>
            ))}
            <tr><td className="td font-medium" colSpan={2}>Total paid</td><td className="td text-right tabular-nums font-medium">{money(paid, cur)}</td><td className="td" colSpan={2} /></tr>
            </tbody>
          </table></div>
        )}
        <form action={addContractPaymentAction} className="grid sm:grid-cols-5 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="contractId" value={c.id} />
          <Field label="Date"><input type="date" name="paymentDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
          <Field label="Reference"><input name="reference" className="input" placeholder="voucher / invoice" /></Field>
          <Field label="Amount"><input type="number" step="any" min={0} name="amount" required className="input" /></Field>
          <Field label="Currency"><select name="currency" defaultValue={cur} className="select">{currencyOptions(cur).map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
          <div><button className="btn btn-sm btn-primary" type="submit">Add</button></div>
        </form>
      </div>

      {/* Provider appraisals */}
      <div className="card p-4">
        <SectionTitle>Provider performance</SectionTitle>
        {appraisals.length > 0 && (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Period</th><th className="th text-right">Quality</th><th className="th text-right">Timeliness</th><th className="th text-right">Compliance</th><th className="th text-right">Overall</th><th className="th text-left">By</th><th className="th" /></tr></thead>
            <tbody>{appraisals.map((a) => (
              <tr key={a.id}><td className="td">{a.period ?? "—"}{a.comments ? <div className="text-xs" style={{ color: "var(--muted)" }}>{a.comments}</div> : null}</td>
                <td className="td text-right tabular-nums">{a.quality ?? "—"}</td><td className="td text-right tabular-nums">{a.timeliness ?? "—"}</td><td className="td text-right tabular-nums">{a.compliance ?? "—"}</td>
                <td className="td text-right tabular-nums font-medium">{appraisalOverall(a) ?? "—"}</td><td className="td">{a.appraisedBy ?? "—"}</td><td className="td text-right"><DelBtn contractId={c.id} kind="appraisal" id={a.id} /></td></tr>
            ))}</tbody>
          </table></div>
        )}
        <form action={addContractAppraisalAction} className="grid sm:grid-cols-5 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="contractId" value={c.id} />
          <Field label="Period"><input name="period" className="input" placeholder="e.g. Q1 2026 / Final" /></Field>
          <Field label="Quality (1-5)"><input type="number" step="0.1" min={0} max={5} name="quality" className="input" /></Field>
          <Field label="Timeliness (1-5)"><input type="number" step="0.1" min={0} max={5} name="timeliness" className="input" /></Field>
          <Field label="Compliance (1-5)"><input type="number" step="0.1" min={0} max={5} name="compliance" className="input" /></Field>
          <div><button className="btn btn-sm btn-primary" type="submit">Add</button></div>
          <div className="sm:col-span-5"><Field label="Comments"><input name="comments" className="input" /></Field></div>
        </form>
      </div>

      {/* Settings */}
      <div className="card p-4 mt-5">
        <SectionTitle>Contract settings</SectionTitle>
        <form action={updateContractAction} className="grid sm:grid-cols-2 gap-3">
          <input type="hidden" name="contractId" value={c.id} />
          <Field label="Reference"><input name="reference" defaultValue={c.reference ?? ""} className="input" /></Field>
          <Field label="Title"><input name="title" required defaultValue={c.title} className="input" /></Field>
          <Field label="Provider (vendor)"><select name="vendorId" defaultValue={c.vendorId ?? ""} className="select"><option value="">— not listed —</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
          <Field label="…or provider name"><input name="providerName" defaultValue={c.vendorId ? "" : (c.providerName ?? "")} className="input" /></Field>
          <Field label="Contract value"><input type="number" step="any" min={0} name="contractValue" defaultValue={c.contractValue} className="input" /></Field>
          <Field label="Currency"><select name="currency" defaultValue={cur} className="select">{currencyOptions(cur).map((x) => <option key={x} value={x}>{x}</option>)}</select></Field>
          <Field label="Start date"><input type="date" name="startDate" defaultValue={c.startDate ?? ""} className="input" /></Field>
          <Field label="End date"><input type="date" name="endDate" defaultValue={c.endDate ?? ""} className="input" /></Field>
          <Field label="Signed date"><input type="date" name="signedDate" defaultValue={c.signedDate ?? ""} className="input" /></Field>
          <div className="sm:col-span-2"><Field label="Scope"><textarea name="scope" rows={2} defaultValue={c.scope ?? ""} className="textarea" /></Field></div>
          <div><button className="btn btn-sm btn-primary" type="submit">Save</button></div>
        </form>
      </div>
    </div>
  );
}
