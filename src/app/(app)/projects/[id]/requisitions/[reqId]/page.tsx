import Link from "next/link";
import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { SectionTitle, Empty, Badge, StatusBadge, Field } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import {
  submitRequisitionAction, decideRequisitionAction,
  addRequisitionAttachmentAction, createVoucherAction, recordReqExpenditureAction,
} from "@/app/actions";

const ROLE_LABEL: Record<string, string> = { finance_admin: "Finance review", pm: "PM / PI approval", admin: "Admin approval" };

export default async function RequisitionDetailPage({ params, searchParams }: {
  params: Promise<{ id: string; reqId: string }>;
  searchParams: Promise<{ voucher?: string }>;
}) {
  const { id, reqId } = await params;
  const sp = await searchParams;
  const access = await getProjectAccess(id);

  const req = await one<{
    id: string; number: string; title: string; amount: number; status: string;
    justification: string | null; neededBy: string | null; payee: string | null;
    disbursedAmount: number; budgetLine: string | null; requester: string | null; createdAt: string;
  }>(
    `SELECT r.id, r.number, r.title, r.amount, r.status, r.justification,
            r.needed_by AS "neededBy", r.payee, r.disbursed_amount AS "disbursedAmount",
            (SELECT code || ' · ' || description FROM budget_line WHERE id=r.budget_line_id) AS "budgetLine",
            (SELECT name FROM app_user WHERE id=r.requested_by_id) AS requester,
            r.created_at AS "createdAt"
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
  const vouchers = await q<{ id: string; number: string; payee: string; amount: number; method: string; reference: string | null; createdAt: string }>(
    `SELECT id, number, payee, amount, method, reference, created_at AS "createdAt"
     FROM payment_voucher WHERE requisition_id=$1 ORDER BY created_at`, [reqId]
  );
  const disbursed = vouchers.reduce((s, v) => s + v.amount, 0);
  const remaining = Math.max(0, req.amount - disbursed);

  const canCreate = access.permissions.has("requisitions.create");
  const myHasSignature = await one<{ id: string }>(`SELECT id FROM signature_asset WHERE user_id=$1 LIMIT 1`, [access.user.id]);
  const canApprove = access.permissions.has("requisitions.approve");
  const canDisburse = access.permissions.has("budget.manage");
  const approved = ["approved", "partially_funded", "disbursed", "retired", "closed"].includes(req.status);
  const myPending = approvals.find((a) => a.decision === "pending");

  return (
    <div className="space-y-6 max-w-4xl">
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
          {approved && (
            <a href={`/print/requisition/${req.id}`} target="_blank" rel="noopener" className="btn btn-sm">
              🖨 Print / Save PDF (letterhead)
            </a>
          )}
          <Link href={`/projects/${id}/requisitions`} className="btn btn-sm">← All requisitions</Link>
        </div>
      </div>

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
          {sp.voucher === "ok" && <p className="text-sm mb-2" style={{ color: "var(--ok)" }}>Voucher created.</p>}
          {sp.voucher === "invalid" && <p className="text-sm mb-2" style={{ color: "var(--danger)" }}>A payee and a positive amount are required.</p>}
          {vouchers.length === 0
            ? <p className="text-sm" style={{ color: "var(--muted)" }}>No funds disbursed yet. Disbursement is recorded as one voucher per payee — the requested amount can be split across several payees or paid partially.</p>
            : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr><th className="th text-left">Voucher</th><th className="th text-left">Payee</th><th className="th text-left">Method</th><th className="th text-left">Reference</th><th className="th text-right">Amount</th><th className="th" /></tr></thead>
                  <tbody>
                    {vouchers.map((v) => (
                      <tr key={v.id}>
                        <td className="td font-mono text-xs">{v.number}</td>
                        <td className="td">{v.payee}</td>
                        <td className="td">{label(v.method)}</td>
                        <td className="td text-xs">{v.reference ?? "—"}</td>
                        <td className="td text-right tabular-nums">{money(v.amount, c)}</td>
                        <td className="td text-right"><a href={`/print/voucher/${v.id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨 Print</a></td>
                      </tr>
                    ))}
                    <tr>
                      <td className="td font-medium" colSpan={4}>Total disbursed</td>
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
