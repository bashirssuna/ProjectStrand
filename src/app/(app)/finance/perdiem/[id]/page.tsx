import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFinanceOrg } from "../../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { updatePerdiemReportAction, approvePerdiemAction, rejectPerdiemAction, markPerdiemPaidAction, deletePerdiemClaimAction, uploadPerdiemEvidenceAction, deletePerdiemEvidenceAction } from "@/app/actions";

export default async function PerdiemClaimPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; err?: string }> }) {
  const { id } = await params;
  const { orgId } = await requireFinanceOrg();
  const sp = await searchParams;

  const c = await one<{ id: string; travellerName: string; purpose: string | null; destination: string | null; startDate: string | null; endDate: string | null; days: number; dailyRate: number; total: number; currency: string; status: string; activityReport: string | null; approvedByName: string | null; approvedAt: string | null; paidOn: string | null; paymentRef: string | null; projectCode: string | null; createdByName: string | null }>(
    `SELECT pc.id, pc.traveller_name AS "travellerName", pc.purpose, pc.destination, pc.start_date AS "startDate",
            pc.end_date AS "endDate", pc.days::float, pc.daily_rate::float AS "dailyRate", pc.total::float, pc.currency, pc.status,
            pc.activity_report AS "activityReport", pc.approved_by_name AS "approvedByName", pc.approved_at AS "approvedAt",
            pc.paid_on AS "paidOn", pc.payment_ref AS "paymentRef", pc.created_by_name AS "createdByName",
            p.code AS "projectCode"
     FROM perdiem_claim pc LEFT JOIN project p ON p.id=pc.project_id WHERE pc.id=$1 AND pc.org_id=$2`, [id, orgId]
  );
  if (!c) notFound();

  const evidence = await q<{ id: string; name: string; sizeBytes: number | null }>(
    `SELECT id, name, size_bytes AS "sizeBytes" FROM perdiem_evidence WHERE claim_id=$1 ORDER BY created_at`, [id]
  );
  const editable = c.status === "draft" || c.status === "rejected";
  const hasReport = Boolean(c.activityReport && c.activityReport.trim());

  return (
    <div className="max-w-3xl">
      <PageHeader title={`Per diem · ${c.travellerName}`} subtitle={c.purpose ?? c.destination ?? "Travel claim"} actions={<Link href="/finance/perdiem" className="btn btn-sm">← Per diem</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.err === "noreport" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>An activity report is required before this claim can be approved (Finance Policy §14.2).</div>}
      {sp.err === "file" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Choose a file to upload.</div>}

      <div className="card p-4 mb-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          {c.status === "paid" ? <Badge tone="ok">paid {c.paidOn ? fmtDate(c.paidOn) : ""}</Badge>
            : c.status === "approved" ? <Badge tone="info">approved</Badge>
            : c.status === "rejected" ? <Badge tone="danger">rejected</Badge> : <Badge tone="muted">draft</Badge>}
          <span className="text-2xl font-semibold tabular-nums">{money(c.total, c.currency)}</span>
        </div>
        <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1 text-sm mt-3">
          <div><span style={{ color: "var(--muted)" }}>Dates: </span>{c.startDate ? fmtDate(c.startDate) : "—"}{c.endDate ? ` → ${fmtDate(c.endDate)}` : ""}</div>
          <div><span style={{ color: "var(--muted)" }}>Days × rate: </span>{c.days} × {money(c.dailyRate, c.currency)}</div>
          <div><span style={{ color: "var(--muted)" }}>Destination: </span>{c.destination ?? "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Project: </span>{c.projectCode ?? "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Raised by: </span>{c.createdByName ?? "—"}</div>
          {c.approvedByName && <div><span style={{ color: "var(--muted)" }}>Approved by: </span>{c.approvedByName}{c.approvedAt ? ` · ${fmtDateTime(c.approvedAt)}` : ""}</div>}
          {c.paymentRef && <div><span style={{ color: "var(--muted)" }}>Payment ref: </span>{c.paymentRef}</div>}
        </div>
      </div>

      {/* Activity report */}
      <SectionTitle>Activity report</SectionTitle>
      {editable ? (
        <form action={updatePerdiemReportAction} className="card p-4 mb-5">
          <input type="hidden" name="claimId" value={c.id} />
          <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Describe the work carried out during the trip. Required before approval.</p>
          <textarea name="activityReport" rows={5} defaultValue={c.activityReport ?? ""} className="textarea" placeholder="What was done, where, outcomes…" />
          <div className="grid sm:grid-cols-3 gap-3 mt-3">
            <Field label="Purpose"><input name="purpose" defaultValue={c.purpose ?? ""} className="input" /></Field>
            <Field label="Days"><input type="number" step="0.5" name="days" defaultValue={c.days} className="input" /></Field>
            <Field label="Daily rate"><input type="number" step="0.01" name="dailyRate" defaultValue={c.dailyRate} className="input" /></Field>
          </div>
          <div className="flex justify-end mt-2"><button className="btn btn-primary" type="submit">Save report</button></div>
        </form>
      ) : (
        <div className="card p-4 mb-5 text-sm whitespace-pre-wrap">{c.activityReport || <span style={{ color: "var(--muted)" }}>No report recorded.</span>}</div>
      )}

      {/* Evidence */}
      <SectionTitle>Supporting evidence</SectionTitle>
      <div className="card p-4 mb-5">
        {evidence.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>No photos or documents attached.</p> : (
          <ul className="text-sm space-y-1 mb-3">
            {evidence.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2">
                <a href={`/api/perdiem-files/${e.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{e.name}</a>
                <form action={deletePerdiemEvidenceAction}><input type="hidden" name="claimId" value={c.id} /><input type="hidden" name="evidenceId" value={e.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Remove</button></form>
              </li>
            ))}
          </ul>
        )}
        <form action={uploadPerdiemEvidenceAction} className="flex items-end gap-2">
          <input type="hidden" name="claimId" value={c.id} />
          <Field label="Add photo / document"><input type="file" name="file" className="input" /></Field>
          <button className="btn btn-sm" type="submit">Upload</button>
        </form>
      </div>

      {/* Workflow */}
      <SectionTitle>Decision</SectionTitle>
      <div className="card p-4 flex flex-wrap items-end gap-2">
        {(c.status === "draft" || c.status === "rejected") && (
          <>
            <form action={approvePerdiemAction}><input type="hidden" name="claimId" value={c.id} /><button className="btn btn-sm btn-primary" type="submit" disabled={!hasReport}>Approve</button></form>
            <form action={rejectPerdiemAction}><input type="hidden" name="claimId" value={c.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reject</button></form>
            {!hasReport && <span className="text-xs" style={{ color: "var(--warn)" }}>Add an activity report to enable approval.</span>}
          </>
        )}
        {c.status === "approved" && (
          <form action={markPerdiemPaidAction} className="flex items-end gap-2">
            <input type="hidden" name="claimId" value={c.id} />
            <Field label="Paid on"><input type="date" name="paidOn" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
            <Field label="Payment ref"><input name="paymentRef" className="input" placeholder="Bank transfer ref" /></Field>
            <button className="btn btn-sm btn-primary" type="submit">Mark paid</button>
          </form>
        )}
        {c.status === "paid" && <span className="text-sm" style={{ color: "var(--ok)" }}>This claim has been paid.</span>}
        <div className="ml-auto">
          <form action={deletePerdiemClaimAction}><input type="hidden" name="claimId" value={c.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete claim</button></form>
        </div>
      </div>
    </div>
  );
}
