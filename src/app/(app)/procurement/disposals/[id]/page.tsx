import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireProcOrg } from "../../_guard";
import { isModuleEnabled } from "@/server/modules";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Stat } from "@/components/ui";
import { money, fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { submitDisposalAction, boardSurveyDisposalAction, decideDisposalAction, markDisposedAction, deleteDisposalAction } from "@/app/actions";

const FLOW = ["draft", "submitted", "board_survey", "approved", "disposed"];

export default async function DisposalDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const { orgId } = await requireProcOrg();
  if (!(await isModuleEnabled(orgId, "public_procurement"))) redirect("/procurement");
  const sp = await searchParams;

  const d = await one<{
    id: string; reference: string | null; description: string; method: string; status: string; quantity: number | null;
    estimatedValue: number; currency: string | null; reason: string | null; boardSurveyDate: string | null; decidedBy: string | null;
    decidedAt: string | null; disposedDate: string | null; proceeds: number | null; committeeName: string | null; assetName: string | null; assetTag: string | null; itemName: string | null;
  }>(
    `SELECT d.id, d.reference, d.description, d.method, d.status, d.quantity::float8 AS quantity, d.estimated_value::float8 AS "estimatedValue", d.currency, d.reason,
            d.board_survey_date::text AS "boardSurveyDate", d.decided_by AS "decidedBy", d.decided_at::text AS "decidedAt", d.disposed_date::text AS "disposedDate", d.proceeds::float8 AS proceeds,
            c.name AS "committeeName", a.name AS "assetName", a.tag AS "assetTag", si.name AS "itemName"
     FROM disposal d LEFT JOIN proc_committee c ON c.id=d.committee_id LEFT JOIN fixed_asset a ON a.id=d.asset_id LEFT JOIN stock_item si ON si.id=d.stock_item_id
     WHERE d.id=$1 AND d.org_id=$2`, [id, orgId]
  );
  if (!d) notFound();
  const committees = await q<{ id: string; name: string }>(`SELECT id, name FROM proc_committee WHERE org_id=$1 AND type='disposal' AND status='active' ORDER BY name`, [orgId]);
  const cur = d.currency ?? "USD";
  const stepIdx = FLOW.indexOf(d.status);

  return (
    <div className="max-w-3xl">
      <PageHeader title={`${d.reference ? d.reference + " — " : ""}${d.description}`} subtitle={`Disposal · ${label(d.method)}`}
        actions={<div className="flex gap-2">
          <form action={deleteDisposalAction} className="inline"><input type="hidden" name="disposalId" value={d.id} /><ConfirmSubmit message="Delete this disposal record?"><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button></ConfirmSubmit></form>
          <Link href="/procurement/disposals" className="btn btn-sm">← Disposals</Link>
        </div>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Disposal created.</div>}
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Updated.</div>}

      {/* Workflow stepper */}
      <div className="card p-4 mb-5">
        <div className="flex items-center gap-2 mb-4 flex-wrap">
          {d.status === "rejected"
            ? <Badge tone="danger">Rejected</Badge>
            : FLOW.map((s, i) => (
              <span key={s} className="flex items-center gap-2">
                <Badge tone={i < stepIdx ? "ok" : i === stepIdx ? "brand" : "muted"}>{label(s)}</Badge>
                {i < FLOW.length - 1 && <span style={{ color: "var(--muted)" }}>›</span>}
              </span>
            ))}
        </div>

        {/* Stage action */}
        {d.status === "draft" && (
          <form action={submitDisposalAction}><input type="hidden" name="disposalId" value={d.id} />
            <p className="text-sm mb-2" style={{ color: "var(--muted)" }}>Submit this disposal for review.</p>
            <button className="btn btn-primary" type="submit">Submit for review</button>
          </form>
        )}
        {d.status === "submitted" && (
          <form action={boardSurveyDisposalAction} className="grid sm:grid-cols-3 gap-3 items-end"><input type="hidden" name="disposalId" value={d.id} />
            <Field label="Board of survey date"><input type="date" name="boardSurveyDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
            <Field label="Disposal committee"><select name="committeeId" className="select"><option value="">—</option>{committees.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
            <div><button className="btn btn-primary" type="submit">Record board of survey</button></div>
          </form>
        )}
        {(d.status === "board_survey" || d.status === "submitted") && (
          <form action={decideDisposalAction} className="mt-3 flex flex-wrap gap-2 items-end"><input type="hidden" name="disposalId" value={d.id} />
            <Field label="Committee decision"><select name="decision" defaultValue="approved" className="select"><option value="approved">Approve</option><option value="rejected">Reject</option></select></Field>
            <button className="btn btn-primary" type="submit">Record decision</button>
          </form>
        )}
        {d.status === "approved" && (
          <form action={markDisposedAction} className="grid sm:grid-cols-3 gap-3 items-end"><input type="hidden" name="disposalId" value={d.id} />
            <Field label="Disposed date"><input type="date" name="disposedDate" defaultValue={new Date().toISOString().slice(0, 10)} className="input" /></Field>
            <Field label={`Proceeds (${cur})`}><input type="number" step="any" min={0} name="proceeds" className="input" placeholder="0" /></Field>
            <div><button className="btn btn-primary" type="submit">Mark disposed</button></div>
          </form>
        )}
        {d.status === "disposed" && <p className="text-sm" style={{ color: "var(--ok)" }}>Disposed on {d.disposedDate ? fmtDate(d.disposedDate) : "—"}{d.proceeds != null ? ` · proceeds ${money(d.proceeds, cur)}` : ""}.{d.assetName ? " The linked asset was retired in the register." : ""}</p>}
        {d.status === "rejected" && <p className="text-sm" style={{ color: "var(--danger)" }}>This disposal was rejected{d.decidedBy ? ` by ${d.decidedBy}` : ""}.</p>}
      </div>

      {/* Details */}
      <div className="card p-4">
        <SectionTitle>Details</SectionTitle>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <Stat label="Estimated value" value={money(d.estimatedValue, cur)} />
          <Stat label="Quantity" value={d.quantity != null ? String(d.quantity) : "—"} />
          <Stat label="Proceeds" value={d.proceeds != null ? money(d.proceeds, cur) : "—"} />
          <Stat label="Method" value={label(d.method)} />
        </div>
        <div className="grid sm:grid-cols-2 gap-y-1 text-sm">
          <div><span style={{ color: "var(--muted)" }}>Asset: </span>{d.assetName ? `${d.assetTag ? d.assetTag + " · " : ""}${d.assetName}` : "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Stock item: </span>{d.itemName ?? "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Committee: </span>{d.committeeName ?? "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Board of survey: </span>{d.boardSurveyDate ? fmtDate(d.boardSurveyDate) : "—"}</div>
          <div><span style={{ color: "var(--muted)" }}>Decided by: </span>{d.decidedBy ?? "—"}{d.decidedAt ? ` · ${fmtDateTime(d.decidedAt)}` : ""}</div>
          {d.reason && <div className="sm:col-span-2"><span style={{ color: "var(--muted)" }}>Reason: </span>{d.reason}</div>}
        </div>
      </div>
    </div>
  );
}
