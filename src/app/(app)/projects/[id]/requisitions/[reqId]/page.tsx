import Link from "next/link";
import { redirect } from "next/navigation";
import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import {
  submitRequisitionAction, decideRequisitionAction, disburseAction, recordReqExpenditureAction,
} from "@/app/actions";
import { Badge, StatusBadge, SectionTitle, Field } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";

const ROLE_LABEL: Record<string, string> = { finance_admin: "Finance review", pm: "PM / PI approval", admin: "Admin approval" };

export default async function RequisitionDetail({ params }: { params: Promise<{ id: string; reqId: string }> }) {
  const { id, reqId } = await params;
  const access = await getProjectAccess(id);
  const proj = await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [id]);
  const c = proj?.currency ?? "USD";

  const req = await one<{
    id: string; number: string; title: string; amount: number; status: string;
    justification: string | null; neededBy: string | null; payee: string | null;
    disbursedAmount: number; disbursementRef: string | null;
    requester: string | null; lineDesc: string | null; lineCode: string | null;
    activityTitle: string | null; createdAt: string;
  }>(
    `SELECT r.id, r.number, r.title, r.amount, r.status, r.justification,
            r.needed_by AS "neededBy", r.payee, r.disbursed_amount AS "disbursedAmount",
            r.disbursement_ref AS "disbursementRef", r.created_at AS "createdAt",
            u.name AS requester, bl.description AS "lineDesc", bl.code AS "lineCode", a.title AS "activityTitle"
     FROM requisition r
     LEFT JOIN app_user u ON u.id = r.requested_by_id
     LEFT JOIN budget_line bl ON bl.id = r.budget_line_id
     LEFT JOIN activity a ON a.id = r.activity_id
     WHERE r.id=$1 AND r.project_id=$2`, [reqId, id]
  );
  if (!req) redirect(`/projects/${id}/requisitions`);

  const approvals = await q<{
    id: string; step: number; role: string; decision: string; comment: string | null;
    approver: string | null; decidedAt: string | null; signatureUrl: string | null;
  }>(
    `SELECT ra.id, ra.step, ra.role, ra.decision, ra.comment, ra.decided_at AS "decidedAt",
            u.name AS approver, s.data_url AS "signatureUrl"
     FROM requisition_approval ra
     LEFT JOIN app_user u ON u.id = ra.approver_id
     LEFT JOIN signature_asset s ON s.id = ra.signature_id
     WHERE ra.requisition_id=$1 ORDER BY ra.step`, [reqId]
  );

  const nextPending = approvals.find((a) => a.decision === "pending");
  const canApprove = access.permissions.has("requisitions.approve");
  const canCreate = access.permissions.has("requisitions.create");
  const canDisburse = access.permissions.has("budget.manage");
  const myHasSignature = await one<{ id: string }>(`SELECT id FROM signature_asset WHERE user_id=$1 LIMIT 1`, [access.user.id]);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm">{req.number}</span>
            <StatusBadge status={req.status} />
          </div>
          <h2 className="font-display text-xl font-semibold mt-1">{req.title}</h2>
        </div>
        <Link href={`/projects/${id}/requisitions`} className="btn btn-sm">Back</Link>
      </div>

      <div className="card p-5 grid sm:grid-cols-2 gap-y-3 gap-x-6 text-sm">
        <div><div className="label">Amount</div><div className="text-lg font-semibold tabular-nums">{money(req.amount, c)}</div></div>
        <div><div className="label">Requested by</div><div>{req.requester ?? "—"}</div></div>
        <div><div className="label">Budget line</div><div>{req.lineCode ? `${req.lineCode} · ${req.lineDesc}` : "—"}</div></div>
        <div><div className="label">Activity</div><div>{req.activityTitle ?? "—"}</div></div>
        <div><div className="label">Payee</div><div>{req.payee ?? "—"}</div></div>
        <div><div className="label">Needed by</div><div>{fmtDate(req.neededBy)}</div></div>
        {req.justification && <div className="sm:col-span-2"><div className="label">Justification</div><div>{req.justification}</div></div>}
        {req.disbursedAmount > 0 && (
          <div className="sm:col-span-2"><div className="label">Disbursed</div><div>{money(req.disbursedAmount, c)} · ref {req.disbursementRef ?? "—"}</div></div>
        )}
      </div>

      <div>
        <SectionTitle>Approval chain</SectionTitle>
        {approvals.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>Not yet submitted — no approval steps created.</p>
        ) : (
          <div className="card divide-y" style={{ borderColor: "var(--border)" }}>
            {approvals.map((a) => (
              <div key={a.id} className="p-4 flex items-start justify-between gap-3" style={{ borderColor: "var(--border)" }}>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">Step {a.step}: {ROLE_LABEL[a.role] ?? label(a.role)}</span>
                    <Badge tone={a.decision === "approved" ? "ok" : a.decision === "rejected" ? "danger" : a.id === nextPending?.id ? "info" : "muted"}>
                      {a.decision === "pending" && a.id === nextPending?.id ? "awaiting" : label(a.decision)}
                    </Badge>
                  </div>
                  {a.approver && <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>{a.approver} · {fmtDateTime(a.decidedAt)}</div>}
                  {a.comment && <div className="text-sm mt-1 italic">“{a.comment}”</div>}
                </div>
                {a.signatureUrl && (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img src={a.signatureUrl} alt="signature" className="h-12 border rounded" style={{ borderColor: "var(--border)", background: "white" }} />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="space-y-3">
        {req.status === "draft" && canCreate && (
          <form action={submitRequisitionAction}>
            <input type="hidden" name="projectId" value={id} />
            <input type="hidden" name="reqId" value={reqId} />
            <button className="btn btn-primary" type="submit">Submit for approval</button>
          </form>
        )}

        {nextPending && canApprove && (
          <div className="card p-4">
            <SectionTitle>Your decision — {ROLE_LABEL[nextPending.role] ?? label(nextPending.role)}</SectionTitle>
            {!myHasSignature && (
              <p className="text-xs mb-3" style={{ color: "var(--warn)" }}>
                You have no signature on file. <Link href="/profile" className="underline">Add one</Link> to sign on approval.
              </p>
            )}
            <form action={decideRequisitionAction} className="space-y-3">
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="reqId" value={reqId} />
              <Field label="Comment"><textarea name="comment" rows={2} className="textarea" placeholder="Optional approval note" /></Field>
              <div className="flex gap-2">
                <button name="decision" value="approved" className="btn btn-primary" type="submit">Approve &amp; sign</button>
                <button name="decision" value="rejected" className="btn btn-danger" type="submit">Reject</button>
              </div>
            </form>
          </div>
        )}

        {req.status === "approved" && canDisburse && (
          <div className="card p-4">
            <SectionTitle>Disburse funds</SectionTitle>
            <form action={disburseAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="reqId" value={reqId} />
              <Field label="Amount"><input type="number" step="0.01" name="amount" defaultValue={req.amount} className="input" /></Field>
              <Field label="Reference"><input name="ref" className="input" placeholder="Payment ref" /></Field>
              <button className="btn btn-primary" type="submit">Record disbursement</button>
            </form>
          </div>
        )}

        {(req.status === "disbursed" || req.status === "partially_funded") && canDisburse && (
          <div className="card p-4">
            <SectionTitle>Retire / account for funds</SectionTitle>
            <form action={recordReqExpenditureAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="reqId" value={reqId} />
              <Field label="Amount spent"><input type="number" step="0.01" name="amount" defaultValue={req.disbursedAmount || req.amount} className="input" /></Field>
              <Field label="Reference"><input name="reference" required className="input" placeholder="Invoice / receipt no." /></Field>
              <Field label="Payee"><input name="payee" defaultValue={req.payee ?? ""} className="input" /></Field>
              <button className="btn btn-primary" type="submit">Record expenditure</button>
            </form>
            <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>This posts the expenditure, releases the commitment, and re-runs anomaly checks.</p>
          </div>
        )}
      </div>
    </div>
  );
}
