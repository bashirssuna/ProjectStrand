import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { q, one } from "@/server/db";
import { quotationGate, listQuotations, seedPurchaseApprovalChain } from "@/server/services/procurement";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { SignField } from "@/components/sign-field";
import { createPOAction, addQuotationAction, selectQuotationAction, deleteQuotationAction, saveSingleSourceJustificationAction, assignPurchaseApproverAction, signPurchaseRequestAction } from "@/app/actions";

export default async function PurchaseRequestDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; err?: string; assigned?: string; signed?: string; created?: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  const orgId = org.id;
  const sp = await searchParams;

  const pr = await one<{ id: string; number: string; title: string; status: string; estimatedTotal: number; currency: string; neededBy: string | null; justification: string | null; requestedByName: string | null; projectCode: string | null; projectId: string | null; lineCode: string | null; lineDesc: string | null; singleSource: string | null }>(
    `SELECT pr.id, pr.number, pr.title, pr.status, pr.estimated_total::float AS "estimatedTotal", pr.currency,
            pr.needed_by AS "neededBy", pr.justification, pr.requested_by_name AS "requestedByName",
            pr.single_source_justification AS "singleSource",
            p.code AS "projectCode", p.id AS "projectId", bl.code AS "lineCode", bl.description AS "lineDesc"
     FROM purchase_request pr LEFT JOIN project p ON p.id=pr.project_id LEFT JOIN budget_line bl ON bl.id=pr.budget_line_id
     WHERE pr.id=$1 AND pr.org_id=$2`, [id, orgId]
  );
  if (!pr) notFound();
  // Access: org admins (and super admins) administer the request; an assigned chain
  // signatory may open it to sign their step even if they are not an administrator.
  const canAdminister = org.isOrgAdmin || user.isSuperAdmin;
  const isAssignedApprover = !!(await one<{ ok: number }>(`SELECT 1 AS ok FROM purchase_approval WHERE request_id=$1 AND approver_id=$2`, [id, user.id]));
  if (!canAdminister && !isAssignedApprover) redirect("/dashboard");
  // Lazy-seed the chain for requests created before the chain existed.
  if (pr.status === "submitted") await seedPurchaseApprovalChain(id, !!pr.projectId);
  const steps = await q<{ step: number; role: string; approverId: string | null; approverName: string | null; decision: string; comment: string | null; signatureData: string | null; decidedAt: string | null }>(
    `SELECT step, role, approver_id AS "approverId", approver_name AS "approverName", decision, comment, signature_data AS "signatureData", decided_at AS "decidedAt" FROM purchase_approval WHERE request_id=$1 ORDER BY step ASC`, [id]
  );
  const currentStep = steps.find((s) => s.decision === "pending");
  const orgUsers = canAdminister ? await q<{ id: string; name: string; email: string }>(
    `SELECT u.id, u.name, u.email FROM app_user u JOIN org_membership m ON m.user_id=u.id WHERE m.org_id=$1 ORDER BY u.name`, [orgId]
  ) : [];

  const items = await q<{ description: string; quantity: number; unit: string | null; estimatedUnitCost: number; amount: number }>(
    `SELECT description, quantity::float, unit, estimated_unit_cost::float AS "estimatedUnitCost", amount::float FROM purchase_request_item WHERE request_id=$1`, [id]
  );
  const quotes = await listQuotations(id);
  const gate = await quotationGate(orgId, id);
  const vendors = await q<{ id: string; name: string }>(`SELECT id, name FROM vendor WHERE org_id=$1 AND active ORDER BY name`, [orgId]);

  return (
    <div className="max-w-4xl">
      <PageHeader title={`${pr.number} · ${pr.title}`} subtitle="Purchase request" actions={<Link href="/procurement/requests" className="btn btn-sm">← Requests</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Purchase request created. Assign signatories in the approval chain below to start the sign-off.</div>}
      {sp.err === "quotefields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A vendor name is required for a quotation.</div>}
      {sp.err && sp.err !== "quotefields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.err)}</div>}

      <div className="card p-4 mb-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <StatusBadge status={pr.status} />
          <span className="text-xl font-semibold tabular-nums">{money(pr.estimatedTotal, pr.currency)}</span>
        </div>
        <div className="text-sm mt-2" style={{ color: "var(--muted)" }}>
          By {pr.requestedByName ?? "—"}{pr.neededBy ? ` · needed by ${fmtDate(pr.neededBy)}` : ""}
          {pr.projectCode ? <> · charged to <span style={{ color: "var(--brand)" }}>{pr.projectCode}</span>{pr.lineCode ? ` line ${pr.lineCode}` : ""}</> : ""}
        </div>
        {pr.justification && <div className="text-sm mt-2">{pr.justification}</div>}
        {items.length > 0 && (
          <table className="w-full text-sm mt-3">
            <thead><tr><th className="th text-left">Item</th><th className="th text-right">Qty</th><th className="th text-right">Unit cost</th><th className="th text-right">Amount</th></tr></thead>
            <tbody>{items.map((it, i) => (
              <tr key={i}><td className="td">{it.description}</td><td className="td text-right">{it.quantity}{it.unit ? ` ${it.unit}` : ""}</td><td className="td text-right tabular-nums">{money(it.estimatedUnitCost, pr.currency)}</td><td className="td text-right tabular-nums">{money(it.amount, pr.currency)}</td></tr>
            ))}</tbody>
          </table>
        )}
      </div>

      {/* Competition gate */}
      <div className="card p-4 mb-5" style={{ borderColor: gate.ok || gate.hasSingleSource ? "var(--ok)" : "var(--warn)" }}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="font-medium">{gate.tierLabel}</div>
          <Badge tone={gate.ok ? "ok" : gate.hasSingleSource ? "info" : "warn"}>
            {gate.have}/{gate.required} quotations{gate.ok ? " — met" : gate.hasSingleSource ? " — single-source justified" : " — more needed"}
          </Badge>
        </div>
        <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>
          {gate.enforce
            ? `This value tier requires ${gate.required} written quotation(s) before approval, unless a single-source justification is recorded.`
            : "Threshold enforcement is currently turned off in procurement settings."}
        </p>
      </div>

      {/* Quotations */}
      <SectionTitle>Quotations</SectionTitle>
      {quotes.length === 0 ? <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>No quotations recorded yet.</p> : (
        <div className="card overflow-x-auto mb-3">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Supplier</th><th className="th text-right">Quote</th><th className="th text-right">Lead time</th><th className="th text-left">Notes</th><th className="th" /></tr></thead>
            <tbody>
              {quotes.map((qt) => (
                <tr key={qt.id} style={qt.selected ? { background: "var(--surface)" } : undefined}>
                  <td className="td">{qt.vendorName} {qt.selected && <Badge tone="ok">selected</Badge>}</td>
                  <td className="td text-right tabular-nums">{money(qt.amount, qt.currency)}</td>
                  <td className="td text-right">{qt.leadTimeDays != null ? `${qt.leadTimeDays}d` : "—"}</td>
                  <td className="td text-xs">{qt.notes ?? "—"}</td>
                  <td className="td text-right whitespace-nowrap">
                    {!qt.selected && (
                      <form action={selectQuotationAction} className="inline"><input type="hidden" name="requestId" value={id} /><input type="hidden" name="quotationId" value={qt.id} /><button className="btn btn-sm" type="submit">Select</button></form>
                    )}{" "}
                    <form action={deleteQuotationAction} className="inline"><input type="hidden" name="requestId" value={id} /><input type="hidden" name="quotationId" value={qt.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form action={addQuotationAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-end mb-5" style={canAdminister ? undefined : { display: "none" }}>
        <input type="hidden" name="requestId" value={id} />
        <Field label="Supplier"><input name="vendorName" list="vendor-names" required className="input" placeholder="Supplier name" />
          <datalist id="vendor-names">{vendors.map((v) => <option key={v.id} value={v.name} />)}</datalist>
        </Field>
        <Field label="Quote amount"><input type="number" step="0.01" name="amount" className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue={pr.currency} className="input" /></Field>
        <Field label="Lead time (days)"><input type="number" name="leadTimeDays" className="input" /></Field>
        <div className="sm:col-span-3"><Field label="Notes (quality, warranty, why chosen…)"><input name="notes" className="input" /></Field></div>
        <div className="flex justify-end"><button className="btn btn-primary" type="submit">Add quotation</button></div>
      </form>

      {/* Single-source justification */}
      {canAdminister && <>
      <SectionTitle>Single-source justification</SectionTitle>
      <form action={saveSingleSourceJustificationAction} className="card p-4 mb-5">
        <input type="hidden" name="requestId" value={id} />
        <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Use only when the required number of quotations cannot be obtained (e.g. a sole supplier). Recording a justification here satisfies the competition gate.</p>
        <textarea name="justification" rows={3} defaultValue={pr.singleSource ?? ""} className="textarea" placeholder="Explain why fewer than the required quotations were obtained…" />
        <div className="flex justify-end mt-2"><button className="btn btn-sm" type="submit">Save justification</button></div>
      </form>
      </>}

      {/* Approval chain — signatures + email */}
      <SectionTitle>Approval chain</SectionTitle>
      {sp.assigned && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Signatory assigned and emailed.</div>}
      {sp.signed === "approved" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Signed — this step is approved.</div>}
      {sp.signed === "rejected" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>The request was rejected.</div>}
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        Every purchase request is signed off step by step. {canAdminister ? "Assign a signatory to each step — they are emailed a link to review and sign. " : "You have been asked to sign this request. "}
        Steps are signed in order; the request is approved only when all steps are signed.
      </p>
      <div className="card mb-5" style={{ overflow: "hidden" }}>
        {steps.length === 0 && <div className="p-4 text-sm" style={{ color: "var(--muted)" }}>No approval steps yet.</div>}
        {steps.map((s, i) => {
          const isCurrent = currentStep?.step === s.step;
          const canSignThis = isCurrent && pr.status === "submitted" && (canAdminister || s.approverId === user.id);
          return (
            <div key={s.step} className="p-4" style={i > 0 ? { borderTop: "1px solid var(--border)" } : undefined}>
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <span className="text-xs font-mono mr-2" style={{ color: "var(--muted)" }}>Step {s.step}</span>
                  <span className="font-medium">{s.role}</span>
                  <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                    {s.approverName ? `Signatory: ${s.approverName}` : "No signatory assigned"}
                    {s.decidedAt ? ` · ${fmtDateTime(s.decidedAt)}` : ""}
                    {s.comment ? ` · “${s.comment}”` : ""}
                  </div>
                </div>
                <Badge tone={s.decision === "approved" ? "ok" : s.decision === "rejected" ? "danger" : isCurrent ? "warn" : "muted"}>
                  {s.decision === "pending" ? (isCurrent ? "awaiting signature" : "waiting") : label(s.decision)}
                </Badge>
              </div>
              {s.signatureData && <img src={s.signatureData} alt="signature" style={{ height: 46, marginTop: 8 }} />}
              {canAdminister && s.decision === "pending" && (
                <form action={assignPurchaseApproverAction} className="flex flex-wrap items-end gap-2 mt-3">
                  <input type="hidden" name="requestId" value={id} />
                  <input type="hidden" name="step" value={s.step} />
                  <Field label="Assign signatory & email them">
                    <select name="approverId" required className="select" style={{ minWidth: 240 }} defaultValue={s.approverId ?? ""}>
                      <option value="">— choose person —</option>
                      {orgUsers.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                    </select>
                  </Field>
                  <button className="btn btn-sm" type="submit">{s.approverId ? "Reassign & notify" : "Assign & notify"}</button>
                </form>
              )}
              {canSignThis && (
                <form action={signPurchaseRequestAction} className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                  <input type="hidden" name="requestId" value={id} />
                  <input type="hidden" name="step" value={s.step} />
                  <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Sign to record your decision. Draw or type your signature below — it is attached to the request on approval.</p>
                  <SignField name="sig" initialName={user.name} />
                  <input name="comment" className="input mt-2" placeholder="Comment (optional)" />
                  <div className="flex gap-2 mt-2">
                    <button className="btn btn-sm btn-primary" name="decision" value="approved" type="submit">Approve &amp; sign</button>
                    <button className="btn btn-sm" name="decision" value="rejected" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reject</button>
                  </div>
                  {s.step === steps[0]?.step && gate.enforce && !gate.ok && !gate.hasSingleSource && <p className="text-xs mt-2" style={{ color: "var(--warn)" }}>Approval is blocked until quotations are met or a single-source justification is recorded.</p>}
                </form>
              )}
            </div>
          );
        })}
      </div>

      {pr.status === "approved" && canAdminister && (
        vendors.length > 0 ? (
          <form action={createPOAction} className="card p-4 flex flex-wrap items-end gap-2">
            <input type="hidden" name="requestId" value={id} />
            <Field label="Vendor for the order"><select name="vendorId" required className="select" style={{ width: 220 }}><option value="">— choose vendor —</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></Field>
            <button className="btn btn-sm btn-primary" type="submit">Create purchase order</button>
          </form>
        ) : <p className="text-sm" style={{ color: "var(--danger)" }}>Add a vendor first to create an order.</p>
      )}
    </div>
  );
}
