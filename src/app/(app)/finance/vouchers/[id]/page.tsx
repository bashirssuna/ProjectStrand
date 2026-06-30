import Link from "next/link";
import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Stat } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { SignField } from "@/components/sign-field";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { budgetLineOptions } from "@/server/services/payment-slips";
import {
  updateVoucherAction, deleteVoucherAction, assignVoucherApproverAction,
  remindVoucherApproverAction, approvePaymentVoucherAction, declineVoucherAction,
} from "@/app/actions";

type SP = { created?: string; updated?: string; assigned?: string; notified?: string; approved?: string; declined?: string; err?: string };

export default async function VoucherDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");

  const v = await one<{
    id: string; number: string; payee: string; amount: number; method: string; reference: string | null; purpose: string | null;
    voucherDate: string; status: string; projectId: string | null; budgetLineId: string | null; accountId: string | null; expenseAccountId: string | null;
    approverId: string | null; approverName: string | null; approverSignature: string | null; declineReason: string | null;
    preparedByName: string | null; checkedByName: string | null; approvedByName: string | null; approvedAt: string | null; expenditureId: string | null;
    projectCode: string | null; projectTitle: string | null; currency: string; lineCode: string | null; lineDescription: string | null;
  }>(
    `SELECT pv.id, pv.number, pv.payee, pv.amount::float, pv.method, pv.reference, pv.purpose,
            COALESCE(pv.voucher_date::text, pv.created_at::text) AS "voucherDate", COALESCE(pv.status,'prepared') AS status,
            pv.project_id AS "projectId", pv.budget_line_id AS "budgetLineId", pv.account_id AS "accountId", pv.expense_account_id AS "expenseAccountId",
            pv.approver_id AS "approverId", pv.approver_name AS "approverName", pv.approver_signature AS "approverSignature", pv.decline_reason AS "declineReason",
            pv.prepared_by_name AS "preparedByName", pv.checked_by_name AS "checkedByName",
            pv.approved_by_name AS "approvedByName", pv.approved_at AS "approvedAt", pv.expenditure_id AS "expenditureId",
            p.code AS "projectCode", p.title AS "projectTitle", COALESCE(p.currency, o.base_currency, 'USD') AS currency,
            bl.code AS "lineCode", bl.description AS "lineDescription"
       FROM payment_voucher pv
       LEFT JOIN project p ON p.id=pv.project_id
       LEFT JOIN organization o ON o.id=pv.org_id
       LEFT JOIN budget_line bl ON bl.id=pv.budget_line_id
      WHERE pv.id=$1 AND pv.org_id=$2`, [id, org.id]
  );
  if (!v) redirect("/finance/vouchers");

  const isFinance = Boolean(org.isOrgAdmin) || user.isSuperAdmin;
  const isApprover = v.approverId === user.id;
  if (!isFinance && !isApprover) redirect("/dashboard");

  const canApprove = (isFinance || isApprover) && v.status === "prepared";
  const editable = isFinance && v.status !== "paid";
  const c = v.currency;

  // Finance-only option lists for assigning/editing.
  const orgUsers = isFinance
    ? await q<{ id: string; name: string; email: string }>(
        `SELECT u.id, u.name, u.email FROM app_user u JOIN org_membership m ON m.user_id=u.id WHERE m.org_id=$1 ORDER BY u.name`, [org.id])
    : [];
  const cashAccts = editable ? await q<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='asset' AND (code LIKE '10%' OR name ILIKE '%cash%' OR name ILIKE '%bank%') AND is_active ORDER BY code`, [org.id]) : [];
  const expenseAccts = editable ? await q<{ id: string; code: string; name: string }>(
    `SELECT id, code, name FROM ledger_account WHERE org_id=$1 AND account_type='expense' AND is_active ORDER BY code`, [org.id]) : [];
  const projects = editable ? await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [org.id]) : [];
  const lineOptions = (isFinance) ? await budgetLineOptions(org.id, v.projectId) : [];
  const linkedLine = lineOptions.find((l) => l.id === v.budgetLineId);

  const statusTone = v.status === "paid" ? "ok" : v.status === "declined" ? "danger" : "muted";

  return (
    <div className="max-w-4xl">
      <PageHeader title={`Voucher ${v.number}`} subtitle={`${v.payee} · ${money(v.amount, c)} · ${fmtDate(v.voucherDate)}`}
        actions={<div className="flex gap-2">
          <a href={`/print/voucher/${v.id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨 Print</a>
          {isFinance ? <Link href="/finance/vouchers" className="btn btn-sm">← All vouchers</Link> : <Link href="/dashboard" className="btn btn-sm">← Dashboard</Link>}
        </div>} />

      {sp.created && <Banner ok>Voucher {sp.created} recorded. Assign an approver below to send it for approval.</Banner>}
      {sp.updated && <Banner ok>Voucher updated.</Banner>}
      {sp.assigned && <Banner ok>Approver assigned and notified by email.</Banner>}
      {sp.notified && <Banner ok>Reminder sent to the approver.</Banner>}
      {sp.approved && <Banner ok>Approved — posted to the ledger{v.expenditureId ? " and deducted from the budget line" : ""}.</Banner>}
      {sp.declined && <Banner>Voucher declined.</Banner>}
      {sp.err === "forbidden" && <Banner danger>You are not authorised to approve this voucher.</Banner>}
      {sp.err === "invalid" && <Banner danger>Enter a payee, a positive amount, and both accounts.</Banner>}
      {sp.err === "approver" && <Banner danger>Choose an employee to approve this voucher.</Banner>}
      {sp.err === "locked" && <Banner danger>This voucher is approved and posted — it can no longer be edited. Delete it if you need to redo it.</Banner>}
      {sp.err && !["forbidden", "invalid", "approver", "locked"].includes(sp.err) && <Banner danger>{decodeURIComponent(sp.err)}</Banner>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Amount" value={money(v.amount, c)} />
        <Stat label="Status" value={label(v.status)} />
        <Stat label="Project" value={v.projectCode ?? "—"} />
        <Stat label="Approver" value={v.approverName ?? "—"} />
      </div>

      {/* Approver action panel */}
      {canApprove && (
        <div className="card p-4 mb-6" style={{ borderColor: "var(--brand)" }}>
          <SectionTitle>{isApprover && !isFinance ? "You have been asked to approve this payment" : "Approve or decline"}</SectionTitle>
          <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
            Approving posts <strong>{money(v.amount, c)}</strong> to the ledger{v.budgetLineId ? <> and deducts it from budget line <strong>{v.lineCode}</strong>{linkedLine && linkedLine.remaining < v.amount ? <span style={{ color: "var(--danger)" }}> (remaining {money(linkedLine.remaining, c)} is less than this voucher)</span> : null}</> : null}. Your name and signature are attached automatically.
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            <form action={approvePaymentVoucherAction}>
              <input type="hidden" name="voucherId" value={v.id} />
              <Field label="Signature (optional — draw, or just approve to use your saved signature)">
                <SignField name="signature" width={380} height={120} initialName={user.name} />
              </Field>
              <button className="btn btn-primary mt-2" type="submit">✓ Approve &amp; sign</button>
            </form>
            <form action={declineVoucherAction} className="flex flex-col">
              <input type="hidden" name="voucherId" value={v.id} />
              <Field label="Reason (optional)"><textarea name="reason" className="textarea" rows={3} placeholder="Why is this being declined?" /></Field>
              <ConfirmSubmit message="Decline this voucher?" className="btn mt-2" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>✗ Decline</ConfirmSubmit>
            </form>
          </div>
        </div>
      )}

      {v.status === "declined" && (
        <Banner danger>This voucher was declined.{v.declineReason ? ` Reason: ${v.declineReason}` : ""}{isFinance ? " You can edit it and re-assign an approver, or delete it." : ""}</Banner>
      )}

      {/* Budget line */}
      {isFinance && (
        <div className="card p-4 mb-6">
          <div className="text-xs uppercase tracking-wide mb-2" style={{ color: "var(--muted)" }}>Budget line</div>
          {v.budgetLineId ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm"><span className="font-medium">{v.lineCode}</span> — {v.lineDescription}
                {linkedLine ? <span style={{ color: "var(--muted)" }}> · remaining {money(linkedLine.remaining, c)}</span> : null}</div>
              {v.expenditureId ? <Badge tone="ok">✓ deducted</Badge> : <Badge tone="info">deducts on approval</Badge>}
            </div>
          ) : <p className="text-sm" style={{ color: "var(--muted)" }}>Not linked to a budget line. {editable ? "Link one in the edit form below so it deducts from the project budget on approval." : ""}</p>}
        </div>
      )}

      {/* Finance: assign approver */}
      {isFinance && v.status === "prepared" && (
        <div className="card p-4 mb-6">
          <SectionTitle action={v.approverId ? <form action={remindVoucherApproverAction}><input type="hidden" name="voucherId" value={v.id} /><button className="btn btn-sm" type="submit">Send reminder</button></form> : undefined}>Approver</SectionTitle>
          {v.approverName && <p className="text-sm mb-2">Assigned to <strong>{v.approverName}</strong> — they have been notified to log in and approve.</p>}
          <form action={assignVoucherApproverAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="voucherId" value={v.id} />
            <div style={{ minWidth: 280, flex: 1 }}>
              <Field label={v.approverId ? "Change approver" : "Choose who approves"}>
                <select name="approverId" className="select" defaultValue={v.approverId ?? ""}>
                  <option value="">— choose an employee —</option>
                  {orgUsers.map((u) => <option key={u.id} value={u.id}>{u.name}{u.email ? ` (${u.email})` : ""}</option>)}
                </select>
              </Field>
            </div>
            <button className="btn btn-sm btn-primary" type="submit">{v.approverId ? "Reassign &amp; notify" : "Assign &amp; notify"}</button>
          </form>
        </div>
      )}

      {/* Finance: edit */}
      {editable && (
        <details className="card p-4 mb-6">
          <summary className="cursor-pointer text-sm font-medium">Edit voucher</summary>
          <form action={updateVoucherAction} className="grid sm:grid-cols-3 gap-3 mt-3">
            <input type="hidden" name="voucherId" value={v.id} />
            <Field label="Voucher date"><input type="date" name="voucherDate" defaultValue={v.voucherDate.slice(0, 10)} className="input" /></Field>
            <Field label="Payee"><input name="payee" required defaultValue={v.payee} className="input" /></Field>
            <Field label="Amount"><input type="number" step="0.01" name="amount" required defaultValue={v.amount} className="input" /></Field>
            <Field label="Project (optional)"><select name="projectId" className="select" defaultValue={v.projectId ?? ""}><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select></Field>
            <Field label="Pay from (cash/bank)"><select name="accountId" required className="select" defaultValue={v.accountId ?? ""}><option value="">— choose —</option>{cashAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
            <Field label="Expense account"><select name="expenseAccountId" required className="select" defaultValue={v.expenseAccountId ?? ""}><option value="">— choose —</option>{expenseAccts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
            {lineOptions.length > 0 && (
              <div className="sm:col-span-3"><Field label="Budget line (optional — deducts on approval)">
                <select name="budgetLineId" className="select" defaultValue={v.budgetLineId ?? ""}><option value="">— none —</option>
                  {lineOptions.map((l) => <option key={l.id} value={l.id}>{l.projectCode} · {l.code} — {l.description} (remaining {money(l.remaining, l.currency)})</option>)}
                </select>
              </Field></div>
            )}
            <Field label="Payment method"><select name="method" className="select" defaultValue={v.method}><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option><option value="cash">Cash</option><option value="mobile_money">Mobile money</option></select></Field>
            <Field label="Reference / cheque no."><input name="reference" defaultValue={v.reference ?? ""} className="input" /></Field>
            <div className="sm:col-span-3"><Field label="Description"><input name="purpose" defaultValue={v.purpose ?? ""} className="input" /></Field></div>
            <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Save changes</button></div>
          </form>
        </details>
      )}

      {/* Sign-off summary */}
      <SectionTitle>Sign-off</SectionTitle>
      <div className="grid sm:grid-cols-3 gap-4 mb-6">
        {[
          { label: "Prepared by", name: v.preparedByName },
          { label: "Checked by (Finance)", name: v.checkedByName },
          { label: "Approved by", name: v.approvedByName, at: v.approvedAt, sig: v.approverSignature },
        ].map((s) => (
          <div key={s.label} className="card p-4">
            <div className="text-xs uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>{s.label}</div>
            {s.sig ? <img src={s.sig} alt="" style={{ maxHeight: 56, marginBottom: 4 }} /> : null}
            <div className="text-sm font-medium">{s.name ?? "—"}</div>
            {s.at ? <div className="text-xs" style={{ color: "var(--muted)" }}>{fmtDateTime(s.at)}</div> : null}
          </div>
        ))}
      </div>

      {/* Finance: delete */}
      {isFinance && (
        <form action={deleteVoucherAction}>
          <input type="hidden" name="voucherId" value={v.id} />
          <ConfirmSubmit
            message={v.status === "paid" ? "This voucher is approved and posted. Deleting it will reverse its ledger entry and restore the budget line. Continue?" : "Delete this voucher? This cannot be undone."}
            className="btn" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>
            Delete voucher
          </ConfirmSubmit>
          {v.status === "paid" && <span className="text-xs ml-2" style={{ color: "var(--muted)" }}>Deleting reverses the ledger entry and restores the budget line.</span>}
        </form>
      )}
    </div>
  );
}

function Banner({ children, ok, danger }: { children: React.ReactNode; ok?: boolean; danger?: boolean }) {
  const color = ok ? "var(--ok)" : danger ? "var(--danger)" : "var(--fg)";
  return <div className="card p-3 mb-3 text-sm" style={{ color, borderColor: color }}>{children}</div>;
}
