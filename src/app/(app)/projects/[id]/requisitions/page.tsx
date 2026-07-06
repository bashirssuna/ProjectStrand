import Link from "next/link";
import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { budgetLineRollups } from "@/server/services/budget";
import { outstandingAdvances, myPendingRequisitions, requisitionTrail, type ApprovalStep } from "@/server/services/requisitions";
import { listRefunds, refundableExpenditures } from "@/server/services/refunds";
import { createRequisitionAction, createRefundRequestAction, editRefundRequestAction, decideRefundAction, financeDecideRefundAction, payRefundAction, acknowledgeRefundAction, sendRefundReminderAction, sendRequisitionReminderAction } from "@/app/actions";
import { CancelButton } from "@/components/cancel-button";
import { SectionTitle, Empty, StatusBadge, Field, Badge } from "@/components/ui";
import { label } from "@/lib/enums";
import { money, fmtDate, fmtDateTime, workingDaysSince } from "@/lib/format";
import { blockStaff } from "../_staffblock";

export default async function RequisitionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ rfd?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  await blockStaff(id);
  const access = await getProjectAccess(id);
  const canCreate = access.permissions.has("requisitions.create");
  const meId = access.user.id;
  const isPi = access.isOrgAdmin || access.role === "pi" || access.role === "co_pi";
  const isFinance = access.isOrgAdmin || access.role === "finance_admin";
  const canRequestRefund = access.permissions.has("project.view");
  const proj = await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [id]);
  const c = proj?.currency ?? "USD";

  const refunds = await listRefunds(id);
  const refundExps = await refundableExpenditures(id);
  const refundFileRows = await q<{ refundId: string; id: string; kind: string; name: string }>(
    `SELECT rf.refund_id AS "refundId", rf.id, rf.kind, rf.name FROM refund_file rf
     JOIN refund_request r ON r.id=rf.refund_id WHERE r.project_id=$1 ORDER BY rf.created_at`, [id]);
  const filesByRefund = new Map<string, { id: string; kind: string; name: string }[]>();
  for (const f of refundFileRows) { const a = filesByRefund.get(f.refundId) ?? []; a.push(f); filesByRefund.set(f.refundId, a); }
  const RFD_MSG: Record<string, string> = {
    created: "Refund requested — sent for approval.", edited: "Request updated.", decided: "Decision recorded.", paid: "Refund marked paid.",
    acknowledged: "Receipt acknowledged. Thank you.", needevidence: "Please attach evidence for the refund.",
    needreason: "Please give a reason for the refund.", needamount: "Enter an amount greater than zero.", needproof: "Please attach proof of payment.",
    selfapprove: "You can't approve your own refund request.", badstate: "That request isn't at a stage where this action applies.",
    badexp: "Pick a valid expenditure to refund against.", reminded: "Reminder sent to the approver by email and in-app.",
    tooearly: "You can send a reminder once it has been waiting 5 working days.", remindsoon: "A reminder was already sent today — try again tomorrow.",
  };

  // My own requests still awaiting a decision (for the "Your pending requests" section).
  const myPendingRefunds = refunds.filter((r) => r.requestedById === meId && ["submitted", "pi_approved"].includes(r.status));
  const myReqs = await myPendingRequisitions(id, meId);
  const reqTrails = new Map<string, ApprovalStep[]>();
  for (const rq of myReqs) reqTrails.set(rq.id, await requisitionTrail(rq.id));

  const reqs = await q<{ id: string; number: string; title: string; amount: number; status: string; neededBy: string | null; requester: string | null }>(
    `SELECT r.id, r.number, r.title, r.amount, r.status, r.needed_by AS "neededBy", u.name AS requester
     FROM requisition r LEFT JOIN app_user u ON u.id = r.requested_by_id
     WHERE r.project_id=$1 ORDER BY r.created_at DESC`, [id]
  );
  const advances = await outstandingAdvances(id);

  const bud = await one<{ id: string }>(`SELECT id FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [id]);
  const lines = bud ? await budgetLineRollups(bud.id) : [];
  const activities = await q<{ id: string; title: string; code: string | null }>(
    `SELECT id, title, code FROM activity WHERE project_id=$1 AND type<>'milestone' ORDER BY "order"`, [id]
  );

  return (
    <div className="space-y-7">
      {/* ---------------- Your pending requests ---------------- */}
      {(myPendingRefunds.length > 0 || myReqs.length > 0) && (
        <div>
          <SectionTitle>Your pending requests</SectionTitle>
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
            Requests you&apos;ve submitted that are still awaiting a decision — who has approved, who hasn&apos;t yet, and when. After 5 working days you can send a reminder.
          </p>
          <div className="space-y-3">
            {myReqs.map((rq) => {
              const trail = reqTrails.get(rq.id) ?? [];
              const wd = workingDaysSince(rq.updatedAt);
              const canRemind = wd >= 5;
              return (
                <div key={rq.id} className="card p-4">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <Badge tone="muted">Requisition</Badge>
                    <Link href={`/projects/${id}/requisitions/${rq.id}`} className="font-mono text-xs hover:underline" style={{ color: "var(--brand)" }}>{rq.number}</Link>
                    <span className="text-sm">{rq.title}</span>
                    <StatusBadge status={rq.status} />
                    <span className="font-medium">{money(rq.amount, c)}</span>
                    <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>Submitted {fmtDateTime(rq.createdAt)} · waiting {wd} working day{wd === 1 ? "" : "s"}</span>
                  </div>
                  <div className="text-xs space-y-0.5 mt-1" style={{ color: "var(--muted)" }}>
                    {trail.map((s) => (
                      <div key={s.step}>
                        {label(s.role)}: {s.decision === "approved" ? <span style={{ color: "var(--ok)" }}>✓ approved by {s.approverName ?? "—"} · {s.decidedAt ? fmtDateTime(s.decidedAt) : ""}</span>
                          : s.decision === "rejected" ? <span style={{ color: "var(--danger)" }}>✕ rejected · {s.decidedAt ? fmtDateTime(s.decidedAt) : ""}</span>
                          : <span>⏳ awaiting decision</span>}
                      </div>
                    ))}
                    {trail.length === 0 && <div>Awaiting the first approval step.</div>}
                  </div>
                  <div className="mt-2">
                    {canRemind ? (
                      <form action={sendRequisitionReminderAction}><input type="hidden" name="projectId" value={id} /><input type="hidden" name="reqId" value={rq.id} />
                        <button className="btn btn-sm" type="submit">🔔 Send reminder{rq.lastRemindedAt ? ` (last ${fmtDate(rq.lastRemindedAt)})` : ""}</button>
                      </form>
                    ) : <span className="text-xs" style={{ color: "var(--muted)" }}>Reminder available after 5 working days ({5 - wd} to go).</span>}
                  </div>
                </div>
              );
            })}
            {myPendingRefunds.map((r) => {
              const waitingSince = r.status === "pi_approved" ? (r.piAt ?? r.createdAt) : r.createdAt;
              const wd = workingDaysSince(waitingSince);
              const canRemind = wd >= 5;
              return (
                <div key={r.id} className="card p-4">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <Badge tone="muted">Refund</Badge>
                    <span className="font-mono text-xs">{r.number}</span>
                    <span className="text-sm">{r.reason}</span>
                    <StatusBadge status={r.status} />
                    <span className="font-medium">{money(r.amount, c)}</span>
                    <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>Submitted {fmtDateTime(r.createdAt)} · waiting {wd} working day{wd === 1 ? "" : "s"}</span>
                  </div>
                  <div className="text-xs space-y-0.5 mt-1" style={{ color: "var(--muted)" }}>
                    {r.requiresPi && <div>PI approval: {r.piDecision === "approved" ? <span style={{ color: "var(--ok)" }}>✓ by {r.piByName} · {r.piAt ? fmtDateTime(r.piAt) : ""}</span> : <span>⏳ awaiting</span>}</div>}
                    <div>Finance approval: {r.financeDecision === "approved" ? <span style={{ color: "var(--ok)" }}>✓ by {r.financeByName} · {r.financeAt ? fmtDateTime(r.financeAt) : ""}</span> : <span>⏳ {r.requiresPi && r.status === "submitted" ? "after PI approves" : "awaiting"}</span>}</div>
                  </div>
                  <div className="mt-2">
                    {canRemind ? (
                      <form action={sendRefundReminderAction}><input type="hidden" name="projectId" value={id} /><input type="hidden" name="refundId" value={r.id} />
                        <button className="btn btn-sm" type="submit">🔔 Send reminder{r.lastRemindedAt ? ` (last ${fmtDate(r.lastRemindedAt)})` : ""}</button>
                      </form>
                    ) : <span className="text-xs" style={{ color: "var(--muted)" }}>Reminder available after 5 working days ({5 - wd} to go).</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {advances.length > 0 && (
        <div>
          <SectionTitle>Advances awaiting accountability</SectionTitle>
          <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>
            Disbursed funds must be fully accounted for within 60 days. Anyone whose unaccounted balance exceeds 25% of their last disbursement
            cannot raise a new requisition until they account for at least 75% of it.
          </p>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Requisition</th><th className="th text-left">Holder</th>
                <th className="th text-right">Disbursed</th><th className="th text-right">Accounted</th>
                <th className="th text-right">Outstanding</th><th className="th text-left">Due</th><th className="th text-left">State</th>
              </tr></thead>
              <tbody>
                {advances.map((a) => (
                  <tr key={a.id}>
                    <td className="td"><Link href={`/projects/${id}/requisitions/${a.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{a.number}</Link> <span style={{ color: "var(--muted)" }}>{a.title}</span></td>
                    <td className="td">{a.requesterName ?? "—"}</td>
                    <td className="td text-right tabular-nums">{money(a.disbursed, c)}</td>
                    <td className="td text-right tabular-nums">{money(a.accounted, c)}</td>
                    <td className="td text-right tabular-nums">{money(a.outstanding, c)}</td>
                    <td className="td">{a.due ? fmtDate(a.due) : "—"}</td>
                    <td className="td">
                      {a.state === "liability" ? <Badge tone="danger">Personal liability ({a.daysOverdue}d over)</Badge>
                        : a.state === "overdue" ? <Badge tone="warn">Overdue {a.daysOverdue}d</Badge>
                        : <Badge tone="info">Open</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div>
        <SectionTitle>Requisitions</SectionTitle>
        {reqs.length === 0 ? (
          <Empty title="No requisitions" hint={canCreate ? "Raise a requisition below to request funds for an activity." : "No requisitions raised yet."} />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Number</th>
                <th className="th text-left">Title</th>
                <th className="th text-left">Requested by</th>
                <th className="th text-left">Needed by</th>
                <th className="th text-left">Status</th>
                <th className="th text-right">Amount</th>
              </tr></thead>
              <tbody>
                {reqs.map((r) => (
                  <tr key={r.id} className="hover:bg-[var(--surface)]">
                    <td className="td"><Link href={`/projects/${id}/requisitions/${r.id}`} className="font-mono text-xs hover:underline" style={{ color: "var(--brand)" }}>{r.number}</Link></td>
                    <td className="td">{r.title}</td>
                    <td className="td">{r.requester ?? "—"}</td>
                    <td className="td whitespace-nowrap">{fmtDate(r.neededBy)}</td>
                    <td className="td"><StatusBadge status={r.status} /></td>
                    <td className="td text-right tabular-nums font-medium">{money(r.amount, c)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ---------------- Refunds & reimbursements ---------------- */}
      {sp.rfd && (
        <div className="card p-3 text-sm" style={{ color: ["created", "decided", "paid", "acknowledged"].includes(sp.rfd) ? "var(--ok)" : "var(--danger)", borderColor: ["created", "decided", "paid", "acknowledged"].includes(sp.rfd) ? "var(--ok)" : "var(--danger)" }}>
          {RFD_MSG[sp.rfd] ?? ""}
        </div>
      )}
      <div>
        <SectionTitle>Refunds &amp; reimbursements</SectionTitle>
        <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
          Claim money back for spend already recorded in <Link href={`/projects/${id}/spending`} className="hover:underline" style={{ color: "var(--brand)" }}>Spending</Link>, with evidence attached.
          PI / Co-PI requests are approved by Finance alone; everyone else is routed to the PI first, then Finance. When paid, Finance attaches proof of payment and the requester acknowledges receipt.
          Nothing reaches the general ledger or financial statements until Finance gives final approval.
        </p>

        {refunds.length === 0 ? (
          <Empty title="No refund requests" hint={canRequestRefund ? "Request a reimbursement below." : "No refunds requested yet."} />
        ) : (
          <div className="space-y-3">
            {refunds.map((r) => {
              const files = filesByRefund.get(r.id) ?? [];
              const evidence = files.filter((f) => f.kind === "evidence");
              const proof = files.filter((f) => f.kind === "proof");
              const isRequester = r.requestedById === meId;
              const canPiAct = isPi && !isRequester && r.status === "submitted" && r.requiresPi;
              const canFinAct = isFinance && !isRequester && r.status === (r.requiresPi ? "pi_approved" : "submitted");
              const canPay = isFinance && r.status === "approved";
              const canAck = isRequester && r.status === "paid";
              const canEditRefund = (isRequester || isFinance) && ["submitted", "pi_approved"].includes(r.status);
              return (
                <div key={r.id} className="card p-4">
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="font-mono text-xs">{r.number}</span>
                    <StatusBadge status={r.status} />
                    <span className="font-medium">{money(r.amount, c)}</span>
                    <span className="text-sm" style={{ color: "var(--muted)" }}>· {r.requestedByName ?? "—"} ({label(r.requesterRole ?? "member")})</span>
                    <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>{r.lineCode ? `${r.lineCode} · ` : ""}{r.expenditurePayee ?? r.expenditureRef ?? "expenditure"}</span>
                  </div>
                  {r.reason && <p className="text-sm mb-2">{r.reason}</p>}
                  {(r.bankDetails || r.momoDetails) && (
                    <div className="text-xs mb-2 rounded p-2" style={{ background: "var(--surface)" }}>
                      <span className="font-medium">Pay to</span>
                      {r.bankDetails && <span> · 🏦 {r.bankDetails}</span>}
                      {r.momoDetails && <span> · 📱 {r.momoDetails}</span>}
                    </div>
                  )}
                  <div className="text-xs mb-2" style={{ color: "var(--muted)" }}>
                    Evidence: {evidence.length ? evidence.map((f) => <a key={f.id} href={`/api/refund-files/${f.id}`} target="_blank" className="hover:underline mr-2" style={{ color: "var(--brand)" }}>📎 {f.name}</a>) : "—"}
                  </div>
                  <div className="text-xs space-y-0.5 mb-1" style={{ color: "var(--muted)" }}>
                    {r.requiresPi && r.piDecision && <div>PI {r.piDecision} by {r.piByName} · {fmtDateTime(r.piAt)}{r.piComment ? ` — ${r.piComment}` : ""}</div>}
                    {r.financeDecision && <div>Finance {r.financeDecision} by {r.financeByName} · {fmtDateTime(r.financeAt)}{r.financeComment ? ` — ${r.financeComment}` : ""}</div>}
                    {r.paidAt && <div>Paid by {r.paidByName} · {fmtDateTime(r.paidAt)}{r.paymentRef ? ` · ref ${r.paymentRef}` : ""}{proof.map((f) => <a key={f.id} href={`/api/refund-files/${f.id}`} target="_blank" className="hover:underline ml-1" style={{ color: "var(--brand)" }}>📎 proof</a>)}</div>}
                    {r.acknowledgedAt && <div style={{ color: "var(--ok)" }}>✓ Acknowledged by requester · {fmtDateTime(r.acknowledgedAt)}{r.acknowledgedNote ? ` — “${r.acknowledgedNote}”` : ""}</div>}
                  </div>

                  {canEditRefund && (
                    <details className="editor inline-block mt-1">
                      <summary className="btn btn-sm inline-block">Edit</summary>
                      <div className="editor-panel card p-4 text-left">
                        <div className="font-medium mb-3">Edit request</div>
                        <form action={editRefundRequestAction} className="grid gap-2">
                          <input type="hidden" name="projectId" value={id} /><input type="hidden" name="refundId" value={r.id} />
                          <Field label="Against expenditure (optional)">
                            <select name="expenditureId" defaultValue={r.expenditureId ?? ""} className="select">
                              <option value="">— none (standalone reimbursement) —</option>
                              {refundExps.map((e) => <option key={e.id} value={e.id}>{(e.reference || e.payee || "expenditure")} — {money(e.amount, c)}</option>)}
                            </select>
                          </Field>
                          <Field label="Amount"><input type="number" step="0.01" name="amount" defaultValue={r.amount} className="input" /></Field>
                          <Field label="Reason"><textarea name="reason" defaultValue={r.reason ?? ""} rows={2} className="textarea" /></Field>
                          <div className="grid sm:grid-cols-2 gap-2">
                            <Field label="Bank details (where to pay)"><textarea name="bankDetails" defaultValue={r.bankDetails ?? ""} rows={2} className="textarea" placeholder="Bank, account name & no., branch" /></Field>
                            <Field label="Mobile money (where to pay)"><textarea name="momoDetails" defaultValue={r.momoDetails ?? ""} rows={2} className="textarea" placeholder="Network, number, name" /></Field>
                          </div>
                          <Field label="Add more evidence (optional)"><input type="file" name="evidence" className="input" /></Field>
                          <div className="flex gap-2"><button className="btn btn-primary btn-sm" type="submit">Save changes</button><CancelButton className="btn btn-sm">Cancel</CancelButton></div>
                        </form>
                      </div>
                    </details>
                  )}

                  {canPiAct && (
                    <form action={decideRefundAction} className="flex flex-wrap items-end gap-2 pt-2 mt-1" style={{ borderTop: "1px solid var(--border)" }}>
                      <input type="hidden" name="projectId" value={id} /><input type="hidden" name="refundId" value={r.id} />
                      <Field label="PI comment"><input name="comment" className="input input-sm" placeholder="optional" /></Field>
                      <button name="decision" value="approved" className="btn btn-sm btn-primary" type="submit">PI approve</button>
                      <button name="decision" value="rejected" className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Reject</button>
                    </form>
                  )}
                  {canFinAct && (
                    <form action={financeDecideRefundAction} className="flex flex-wrap items-end gap-2 pt-2 mt-1" style={{ borderTop: "1px solid var(--border)" }}>
                      <input type="hidden" name="projectId" value={id} /><input type="hidden" name="refundId" value={r.id} />
                      <Field label="Finance comment"><input name="comment" className="input input-sm" placeholder="optional" /></Field>
                      <button name="decision" value="approved" className="btn btn-sm btn-primary" type="submit">Finance approve</button>
                      <button name="decision" value="rejected" className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Reject</button>
                    </form>
                  )}
                  {canPay && (
                    <form action={payRefundAction} className="grid gap-2 pt-2 mt-1" style={{ borderTop: "1px solid var(--border)" }}>
                      <input type="hidden" name="projectId" value={id} /><input type="hidden" name="refundId" value={r.id} />
                      <div className="grid sm:grid-cols-2 gap-2">
                        <Field label="Payment reference"><input name="paymentRef" className="input input-sm" placeholder="e.g. bank txn ref" /></Field>
                        <Field label="Proof of payment (required)"><input type="file" name="proof" required className="input input-sm" /></Field>
                      </div>
                      <div><button className="btn btn-sm btn-primary" type="submit">Mark paid &amp; attach proof</button></div>
                    </form>
                  )}
                  {canAck && (
                    <form action={acknowledgeRefundAction} className="grid gap-2 pt-2 mt-1" style={{ borderTop: "1px solid var(--border)" }}>
                      <input type="hidden" name="projectId" value={id} /><input type="hidden" name="refundId" value={r.id} />
                      <Field label="Acknowledge receipt — note (optional)"><input name="note" className="input input-sm" placeholder="e.g. received in full" /></Field>
                      <div><button className="btn btn-sm btn-primary" type="submit">Acknowledge receipt</button></div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {canRequestRefund && (
          <div className="mt-4">
            <SectionTitle>Request a refund / reimbursement</SectionTitle>
            <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Link it to spend recorded in Spending, or raise a standalone reimbursement (no expenditure) — either way, attach proof.</p>
            <form action={createRefundRequestAction} className="card p-4 grid sm:grid-cols-2 gap-4">
              <input type="hidden" name="projectId" value={id} />
              <Field label="Against expenditure (optional)">
                <select name="expenditureId" className="select">
                  <option value="">— none (standalone reimbursement) —</option>
                  {refundExps.map((e) => <option key={e.id} value={e.id}>{(e.reference || e.payee || "expenditure")} — {money(e.amount, c)}{e.lineCode ? ` (${e.lineCode})` : ""} · {fmtDate(e.date)}</option>)}
                </select>
              </Field>
              <Field label="Amount to refund"><input type="number" step="0.01" name="amount" className="input" placeholder="required if no expenditure is linked" /></Field>
              <div className="sm:col-span-2"><Field label="Reason (required)"><textarea name="reason" required rows={2} className="textarea" placeholder="What is this refund for?" /></Field></div>
              <Field label="Bank details (where to pay you)"><textarea name="bankDetails" rows={2} className="textarea" placeholder="Bank, account name & number, branch" /></Field>
              <Field label="Mobile money (where to pay you)"><textarea name="momoDetails" rows={2} className="textarea" placeholder="Network, number, registered name" /></Field>
              <div className="sm:col-span-2"><Field label="Evidence (required — receipt, invoice, bank slip…)"><input type="file" name="evidence" required className="input" /></Field></div>
              <div className="sm:col-span-2 flex justify-end"><button className="btn btn-primary" type="submit">Request refund</button></div>
            </form>
          </div>
        )}
      </div>

      {canCreate ? (
        <div>
          <SectionTitle>Raise a requisition</SectionTitle>
          <form action={createRequisitionAction} className="card p-4 grid sm:grid-cols-2 gap-4">
            <input type="hidden" name="projectId" value={id} />
            <Field label="Title"><input name="title" required className="input" placeholder="Funds for training workshop" /></Field>
            <Field label="Amount"><input type="number" step="0.01" name="amount" required className="input" /></Field>
            <Field label="Budget line">
              <select name="budgetLineId" className="select">
                <option value="">— none —</option>
                {lines.map((l) => <option key={l.id} value={l.id}>{l.code} · {l.description} ({money(l.remaining, c)} left)</option>)}
              </select>
            </Field>
            <Field label="Activities covered (hold Ctrl/Cmd to select several)">
              <select name="activityIds" multiple size={5} className="select" style={{ height: "auto" }}>
                {activities.map((a) => <option key={a.id} value={a.id}>{a.code ? a.code + " " : ""}{a.title}</option>)}
              </select>
            </Field>
            <Field label="…or type a new activity">
              <input name="newActivity" className="input" placeholder="e.g. Community sensitisation meeting" />
            </Field>
            <Field label="Needed by"><input type="date" name="neededBy" className="input" /></Field>
            <Field label="Payee"><input name="payee" className="input" /></Field>
            <div className="sm:col-span-2"><Field label="Justification"><textarea name="justification" rows={2} className="textarea" /></Field></div>
            <div className="sm:col-span-2 flex justify-end">
              <button className="btn btn-primary" type="submit">Create draft</button>
            </div>
          </form>
        </div>
      ) : (
        <div className="card p-4">
          <SectionTitle>Raise a requisition</SectionTitle>
          <p className="text-sm" style={{ color: "var(--muted)" }}>
            Your current role (<strong>{(access.role ?? "viewer").replace(/_/g, " ")}</strong>) cannot initiate requisitions. This is a deliberate financial control —
            requisitions are raised by the <strong>Coordinator</strong> or <strong>Finance Admin</strong>, then routed to the PI for approval and signature,
            so the same person never both requests and approves the same funds. To raise one yourself, ask an org admin to assign you a coordinator or finance role on this project.
          </p>
        </div>
      )}
    </div>
  );
}
