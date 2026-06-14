import Link from "next/link";
import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { SectionTitle, Empty, Badge, StatusBadge, Field } from "@/components/ui";
import { money, fmtDate, fmtDateTime, dateInput } from "@/lib/format";
import { label } from "@/lib/enums";
import {
  submitRequisitionAction, decideRequisitionAction,
  addRequisitionAttachmentAction, createVoucherAction, recordReqExpenditureAction,
  editRequisitionAction, retractRequisitionAction, checkVoucherAction, approveVoucherAction,
} from "@/app/actions";
import { budgetLineRollups } from "@/server/services/budget";

const ROLE_LABEL: Record<string, string> = { finance_admin: "Finance review", pm: "PM / PI approval", admin: "Admin approval" };

export default async function RequisitionDetailPage({ params, searchParams }: {
  params: Promise<{ id: string; reqId: string }>;
  searchParams: Promise<{ voucher?: string; edit?: string; retract?: string; blocked?: string }>;
}) {
  const { id, reqId } = await params;
  const sp = await searchParams;
  const access = await getProjectAccess(id);

  const req = await one<{
    id: string; number: string; title: string; amount: number; status: string;
    justification: string | null; neededBy: string | null; payee: string | null;
    disbursedAmount: number; budgetLine: string | null; requester: string | null; createdAt: string; requesterId: string | null; budgetLineId: string | null;
    accountedAmount: number; accountabilityDue: string | null; daysOverdue: number;
  }>(
    `SELECT r.id, r.number, r.title, r.amount, r.status, r.justification,
            r.needed_by AS "neededBy", r.payee, r.disbursed_amount AS "disbursedAmount",
            r.budget_line_id AS "budgetLineId",
            r.accounted_amount AS "accountedAmount", r.accountability_due AS "accountabilityDue",
            GREATEST(0, (CURRENT_DATE - r.accountability_due))::int AS "daysOverdue",
            (SELECT code || ' · ' || description FROM budget_line WHERE id=r.budget_line_id) AS "budgetLine",
            (SELECT name FROM app_user WHERE id=r.requested_by_id) AS requester,
            r.created_at AS "createdAt", r.requested_by_id AS "requesterId"
     FROM requisition r WHERE r.id=$1 AND r.project_id=$2`, [reqId, id]
  );
  if (!req) return <Empty title="Requisition not found" hint="It may have been removed." />;

  const c = (await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [id]))?.currency ?? "USD";

  const reqActivities = await q<{ id: string; code: string | null; title: string }>(
    `SELECT a.id, a.code, a.title FROM requisition_activity ra JOIN activity a ON a.id=ra.activity_id
     WHERE ra.requisition_id=$1
     UNION
     SELECT a.id, a.code, a.title FROM requisition r JOIN activity a ON a.id=r.activity_id
     WHERE r.id=$1 AND r.activity_id IS NOT NULL
     ORDER BY code NULLS LAST, title`, [reqId]
  );
  const approvals = await q<{
    id: string; step: number; role: string; decision: string; comment: string | null;
    decidedAt: string | null; approver: string | null; signature: string | null;
  }>(
    `SELECT ra.id, ra.step, ra.role, ra.decision, ra.comment, ra.decided_at AS "decidedAt",
            u.name AS approver,
            (SELECT data_url FROM signature_asset WHERE user_id=ra.approver_id ORDER BY created_at DESC LIMIT 1) AS signature
     FROM requisition_approval ra LEFT JOIN app_user u ON u.id=ra.approver_id
     WHERE ra.requisition_id=$1 ORDER BY ra.step`, [reqId]
  );
  const attachments = await q<{ id: string; name: string; sizeBytes: number | null; createdAt: string }>(
    `SELECT id, name, size_bytes AS "sizeBytes", created_at AS "createdAt"
     FROM requisition_attachment WHERE requisition_id=$1 ORDER BY created_at`, [reqId]
  );
  const vouchers = await q<{
    id: string; number: string; payee: string; amount: number; method: string; reference: string | null;
    status: string; preparedByName: string | null; preparedBy: string | null;
    checkedByName: string | null; checkedBy: string | null; approvedByName: string | null;
  }>(
    `SELECT id, number, payee, amount, method, reference, status,
            prepared_by_name AS "preparedByName", prepared_by AS "preparedBy",
            checked_by_name AS "checkedByName", checked_by AS "checkedBy",
            approved_by_name AS "approvedByName"
     FROM payment_voucher WHERE requisition_id=$1 ORDER BY created_at`, [reqId]
  );
  // Only APPROVED vouchers represent money actually paid out.
  const disbursed = vouchers.filter((v) => v.status === "approved").reduce((s, v) => s + v.amount, 0);
  const remaining = Math.max(0, req.amount - disbursed);

  const canCreate = access.permissions.has("requisitions.create");
  const myHasSignature = await one<{ id: string }>(`SELECT id FROM signature_asset WHERE user_id=$1 LIMIT 1`, [access.user.id]);

  // editing/retracting is for the requester (or an approver acting on their behalf)
  const isRequester = req.requesterId === access.user.id || access.permissions.has("requisitions.approve");
  const anyDecided = (await one<{ c: number }>(`SELECT COUNT(*)::int c FROM requisition_approval WHERE requisition_id=$1 AND decision<>'pending'`, [reqId]))?.c ?? 0;
  const inFlight = ["submitted", "finance_review", "pm_approval", "admin_approval"].includes(req.status);
  const canRetract = canCreate && isRequester && inFlight && anyDecided === 0;
  const canEdit = canCreate && isRequester && req.status === "draft";

  // data for the inline edit form (only queried when needed)
  const budForEdit = canEdit ? await one<{ id: string }>(`SELECT id FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [id]) : null;
  const editLines = budForEdit ? await budgetLineRollups(budForEdit.id) : [];
  const editActivities = canEdit ? await q<{ id: string; title: string; code: string | null }>(
    `SELECT id, title, code FROM activity WHERE project_id=$1 AND type<>'milestone' ORDER BY "order"`, [id]
  ) : [];
  const linkedActivityIds = new Set(reqActivities.map((a) => a.id));
  const canApprove = access.permissions.has("requisitions.approve");
  const canDisburse = access.permissions.has("budget.manage");
  const canApproveVoucher = access.permissions.has("requisitions.sign") || access.permissions.has("requisitions.approve");
  const approved = ["approved", "partially_funded", "disbursed", "retired", "closed"].includes(req.status);
  const myPending = approvals.find((a) => a.decision === "pending");

  return (
    <div className="space-y-6 max-w-4xl">
      {sp.edit === "ok" && <div className="card p-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Requisition updated.</div>}
      {sp.edit === "locked" && <div className="card p-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>This requisition can no longer be edited — it has already been submitted.</div>}
      {sp.retract === "ok" && <div className="card p-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Requisition retracted — it's back to draft and you can edit or re-submit it.</div>}
      {sp.retract === "locked" && <div className="card p-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Too late to retract — an approver has already acted on this requisition.</div>}
      {sp.blocked === "accountability" && <div className="card p-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>
        Can&apos;t submit: the requester still has unaccounted advances exceeding 25% of their previous disbursement. At least 75% of prior funds must be accounted for first (Finance Policy §13.2). See &quot;Advances awaiting accountability&quot; on the requisitions list.
      </div>}
      {req.disbursedAmount > req.accountedAmount + 0.001 && (req.status === "disbursed" || req.status === "partially_funded") && (
        <div className="card p-3 text-sm" style={req.daysOverdue > 14 ? { color: "var(--danger)", borderColor: "var(--danger)" } : req.daysOverdue > 0 ? { color: "var(--warn)", borderColor: "var(--warn)" } : { color: "var(--muted)" }}>
          {req.daysOverdue > 14
            ? `Accountability overdue by ${req.daysOverdue} days — this advance is now treated as a personal liability of ${req.requester ?? "the holder"}, and no further disbursements should be made until it is accounted for (Finance Policy §15.2).`
            : req.daysOverdue > 0
            ? `Accountability overdue by ${req.daysOverdue} days. ${money(req.disbursedAmount - req.accountedAmount, c)} of ${money(req.disbursedAmount, c)} is still unaccounted. After 14 days overdue it becomes a personal liability.`
            : `Accountability due ${req.accountabilityDue ? fmtDate(req.accountabilityDue) : "—"} — ${money(req.disbursedAmount - req.accountedAmount, c)} of ${money(req.disbursedAmount, c)} still to be accounted for (record the expenditure below).`}
        </div>
      )}
      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-mono text-sm" style={{ color: "var(--brand)" }}>{req.number}</span>
              <StatusBadge status={req.status} />
            </div>
            <h2 className="font-display text-xl font-semibold mt-1">{req.title}</h2>
            <div className="text-sm mt-1" style={{ color: "var(--muted)" }}>
              Raised by {req.requester ?? "—"} · {fmtDate(req.createdAt)} · Needed by {fmtDate(req.neededBy)}
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">{money(req.amount, c)}</div>
            {disbursed > 0 && (
              <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                Disbursed {money(disbursed, c)} · Remaining {money(remaining, c)}
              </div>
            )}
          </div>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 mt-4 text-sm">
          <div><span style={{ color: "var(--muted)" }}>Budget line:</span> {req.budgetLine ?? "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Payee:</span> {req.payee ?? "—"}</div>
          {req.justification && <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Justification:</span> {req.justification}</div>}
        </div>
        {reqActivities.length > 0 && (
          <div className="mt-3 text-sm">
            <span style={{ color: "var(--muted)" }}>Activities covered:</span>
            <ul className="mt-1 space-y-0.5">
              {reqActivities.map((a) => (
                <li key={a.id}>• {a.code ? <span className="font-mono text-xs">{a.code} </span> : null}{a.title}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap gap-2 mt-4 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
          {req.status === "draft" && canCreate && (
            <form action={submitRequisitionAction}>
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="reqId" value={req.id} />
              <button className="btn btn-primary btn-sm" type="submit">Submit for approval</button>
            </form>
          )}
          {canRetract && (
            <form action={retractRequisitionAction}>
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="reqId" value={req.id} />
              <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Retract to draft</button>
            </form>
          )}
          {approved && (
            <a href={`/print/requisition/${req.id}`} target="_blank" rel="noopener" className="btn btn-sm">
              🖨 Print / Save PDF (letterhead)
            </a>
          )}
          <Link href={`/projects/${id}/requisitions`} className="btn btn-sm">← All requisitions</Link>
        </div>
      </div>

      {/* Edit (drafts only) */}
      {canEdit && (
        <details>
          <summary className="btn btn-sm cursor-pointer inline-block">✏️ Edit this requisition</summary>
          <form action={editRequisitionAction} className="card p-4 mt-2 grid sm:grid-cols-2 gap-4">
            <input type="hidden" name="projectId" value={id} />
            <input type="hidden" name="reqId" value={req.id} />
            <Field label="Title"><input name="title" required defaultValue={req.title} className="input" /></Field>
            <Field label="Amount"><input type="number" step="0.01" name="amount" required defaultValue={req.amount} className="input" /></Field>
            <Field label="Budget line">
              <select name="budgetLineId" defaultValue={req.budgetLineId ?? ""} className="select">
                <option value="">— none —</option>
                {editLines.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.description} ({money(l.remaining, c)} left)</option>)}
              </select>
            </Field>
            <Field label="Activities covered (hold Ctrl/Cmd to select several)">
              <select name="activityIds" multiple size={5} defaultValue={[...linkedActivityIds]} className="select" style={{ height: "auto" }}>
                {editActivities.map((a) => <option key={a.id} value={a.id}>{a.code ? a.code + " " : ""}{a.title}</option>)}
              </select>
            </Field>
            <Field label="Needed by"><input type="date" name="neededBy" defaultValue={dateInput(req.neededBy)} className="input" /></Field>
            <Field label="Payee"><input name="payee" defaultValue={req.payee ?? ""} className="input" /></Field>
            <div className="sm:col-span-2"><Field label="Justification"><textarea name="justification" rows={2} defaultValue={req.justification ?? ""} className="textarea" /></Field></div>
            <div className="sm:col-span-2 flex justify-end gap-2">
              <button className="btn btn-primary btn-sm" type="submit">Save changes</button>
            </div>
          </form>
        </details>
      )}

      {/* Approval chain */}
      <div>
        <SectionTitle>Approval chain</SectionTitle>
        <div className="card p-4 space-y-3">
          {approvals.length === 0 && <p className="text-sm" style={{ color: "var(--muted)" }}>Not yet submitted — the chain is created on submission.</p>}
          {approvals.map((a) => (
            <div key={a.id} className="flex items-start justify-between gap-3 pb-3 border-b last:border-0 last:pb-0" style={{ borderColor: "var(--border)" }}>
              <div>
                <div className="text-sm font-medium">Step {a.step}: {ROLE_LABEL[a.role] ?? label(a.role)}</div>
                <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                  {a.decision === "pending" ? "Awaiting decision" : `${label(a.decision)} by ${a.approver ?? "—"} · ${fmtDateTime(a.decidedAt)}`}
                  {a.comment ? ` — “${a.comment}”` : ""}
                </div>
                {a.signature && a.decision === "approved" && (
                  <img src={a.signature} alt="signature" style={{ height: 36, marginTop: 4 }} />
                )}
              </div>
              <Badge tone={a.decision === "approved" ? "ok" : a.decision === "rejected" ? "danger" : "warn"}>{label(a.decision)}</Badge>
            </div>
          ))}
          {myPending && canApprove && req.status === "submitted" && !myHasSignature && (
            <p className="text-xs pt-2" style={{ color: "var(--warn)" }}>
              You have no signature on file. <Link href="/profile" className="underline">Add one</Link> to sign on approval.
            </p>
          )}
          {myPending && canApprove && req.status === "submitted" && (
            <form action={decideRequisitionAction} className="flex flex-wrap items-end gap-2 pt-2">
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="reqId" value={req.id} />
              <Field label="Comment (optional)"><input name="comment" className="input" /></Field>
              <button className="btn btn-primary btn-sm" name="decision" value="approved" type="submit">Approve &amp; sign</button>
              <button className="btn btn-sm" name="decision" value="rejected" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reject</button>
            </form>
          )}
        </div>
      </div>

      {/* Supporting documents */}
      <div>
        <SectionTitle>Supporting documents</SectionTitle>
        <div className="card p-4">
          {attachments.length === 0
            ? <p className="text-sm" style={{ color: "var(--muted)" }}>No documents attached (quotes, pro-formas, invoices…).</p>
            : (
              <ul className="space-y-1.5 text-sm">
                {attachments.map((f) => (
                  <li key={f.id} className="flex items-center justify-between gap-3">
                    <a href={`/api/req-files/${f.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>📎 {f.name}</a>
                    <span className="text-xs" style={{ color: "var(--muted)" }}>{fmtDate(f.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          {(canCreate || canApprove) && (
            <form action={addRequisitionAttachmentAction} className="flex flex-wrap items-end gap-2 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="requisitionId" value={req.id} />
              <Field label="Attach a document"><input type="file" name="file" required className="input" /></Field>
              <button className="btn btn-sm" type="submit">Upload</button>
            </form>
          )}
        </div>
      </div>

      {/* Disbursement vouchers */}
      <div>
        <SectionTitle>Disbursement — payment vouchers</SectionTitle>
        <div className="card p-4">
          {sp.voucher === "ok" && <p className="text-sm mb-2" style={{ color: "var(--ok)" }}>Voucher prepared. It now needs to be checked, then approved before payment is made.</p>}
          {sp.voucher === "checked" && <p className="text-sm mb-2" style={{ color: "var(--ok)" }}>Voucher checked. It now awaits final approval to release payment.</p>}
          {sp.voucher === "approved" && <p className="text-sm mb-2" style={{ color: "var(--ok)" }}>Voucher approved — payment released and recorded against the requisition.</p>}
          {sp.voucher === "invalid" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>A payee and a positive amount are required.</p>}
          {sp.voucher === "stage" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>That voucher is not at the right stage for this action.</p>}
          {sp.voucher === "sameprep" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>The person who prepared a voucher can't also check it — ask another finance user.</p>}
          {sp.voucher === "samecheck" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>The person who checked a voucher can't also approve it — ask an authorised signatory.</p>}
          {vouchers.length === 0
            ? <p className="text-sm" style={{ color: "var(--muted)" }}>No vouchers yet. A voucher is prepared per payee, then goes through <strong>Prepared → Checked → Approved</strong>; payment is made (cash or bank) only on approval. The requested amount can be split across several payees or paid partially.</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr><th className="th text-left">Voucher</th><th className="th text-left">Payee</th><th className="th text-left">Method</th><th className="th text-left">Stage</th><th className="th text-right">Amount</th><th className="th" /></tr></thead>
                  <tbody>
                    {vouchers.map((v) => (
                      <tr key={v.id}>
                        <td className="td font-mono text-xs">{v.number}</td>
                        <td className="td">{v.payee}</td>
                        <td className="td">{label(v.method)}</td>
                        <td className="td">
                          <Badge tone={v.status === "approved" ? "ok" : v.status === "checked" ? "info" : "warn"}>{label(v.status)}</Badge>
                          <div className="text-[11px] mt-1" style={{ color: "var(--muted)" }}>
                            Prepared: {v.preparedByName ?? "—"}
                            {v.checkedByName ? <> · Checked: {v.checkedByName}</> : null}
                            {v.approvedByName ? <> · Approved: {v.approvedByName}</> : null}
                          </div>
                        </td>
                        <td className="td text-right tabular-nums">{money(v.amount, c)}</td>
                        <td className="td text-right whitespace-nowrap">
                          <div className="flex gap-1 justify-end">
                            {v.status === "prepared" && canDisburse && v.preparedBy !== access.user.id && (
                              <form action={checkVoucherAction}>
                                <input type="hidden" name="projectId" value={id} />
                                <input type="hidden" name="requisitionId" value={req.id} />
                                <input type="hidden" name="voucherId" value={v.id} />
                                <button className="btn btn-sm" type="submit">Check</button>
                              </form>
                            )}
                            {v.status === "checked" && canApproveVoucher && v.checkedBy !== access.user.id && (
                              <form action={approveVoucherAction}>
                                <input type="hidden" name="projectId" value={id} />
                                <input type="hidden" name="requisitionId" value={req.id} />
                                <input type="hidden" name="voucherId" value={v.id} />
                                <button className="btn btn-primary btn-sm" type="submit">Approve &amp; pay</button>
                              </form>
                            )}
                            <a href={`/print/voucher/${v.id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨 Print</a>
                          </div>
                        </td>
                      </tr>
                    ))}
                    <tr>
                      <td className="td font-medium" colSpan={4}>Total paid (approved vouchers)</td>
                      <td className="td text-right tabular-nums font-medium">{money(disbursed, c)}</td>
                      <td className="td" />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          {canDisburse && approved && req.status !== "closed" && req.status !== "retired" && remaining > 0 && (
            <form action={createVoucherAction} className="grid sm:grid-cols-6 gap-2 items-end mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="requisitionId" value={req.id} />
              <div className="sm:col-span-2"><Field label="Payee (person / institution)"><input name="payee" required className="input" /></Field></div>
              <Field label={`Amount (≤ ${money(remaining, c)})`}><input type="number" step="any" min={0} max={remaining} name="amount" required className="input" /></Field>
              <Field label="Method">
                <select name="method" className="select">
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="mobile_money">Mobile money</option>
                  <option value="cheque">Cheque</option>
                  <option value="cash">Cash</option>
                </select>
              </Field>
              <Field label="Reference"><input name="reference" className="input" placeholder="Txn / cheque no." /></Field>
              <button className="btn btn-primary" type="submit">Create voucher</button>
              <div className="sm:col-span-6"><Field label="Purpose (optional)"><input name="purpose" className="input" /></Field></div>
            </form>
          )}
          {!approved && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Vouchers become available once the requisition is approved.</p>}
        </div>
      </div>

      {/* Retirement / accountability */}
      {(req.status === "disbursed" || req.status === "partially_funded") && canDisburse && (
        <div>
          <SectionTitle>Retire / account for funds</SectionTitle>
          <div className="card p-4">
            <form action={recordReqExpenditureAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="reqId" value={req.id} />
              <Field label="Amount spent"><input type="number" step="0.01" name="amount" defaultValue={req.disbursedAmount || req.amount} className="input" /></Field>
              <Field label="Reference"><input name="reference" required className="input" placeholder="Invoice / receipt no." /></Field>
              <Field label="Payee"><input name="payee" defaultValue={req.payee ?? ""} className="input" /></Field>
              <button className="btn btn-primary" type="submit">Record expenditure</button>
            </form>
            <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>This posts the expenditure against the budget line, releases the commitment, and re-runs anomaly checks.</p>
          </div>
        </div>
      )}
    </div>
  );
}
