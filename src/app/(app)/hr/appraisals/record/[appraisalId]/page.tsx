import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHrOrg } from "../../../_guard";
import { getAppraisal, listItems, ratingLabel, APPRAISAL_STATUSES } from "@/server/services/appraisals";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Badge, Empty } from "@/components/ui";
import { AppraisalSignatures } from "@/components/appraisal-signatures";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import {
  addAppraisalItemAction, updateAppraisalItemAction, deleteAppraisalItemAction,
  saveAppraisalReviewAction, setAppraisalStatusAction, acknowledgeAppraisalAction,
  archiveAppraisalAction, deleteAppraisalAction,
} from "@/app/actions";

const NEXT_STATUS: Record<string, { to: string; label: string } | null> = {
  draft: { to: "self_assessment", label: "Send for self-assessment" },
  self_assessment: { to: "manager_review", label: "Move to manager review" },
  manager_review: { to: "completed", label: "Finalise appraisal" },
  completed: null,
  acknowledged: null,
};

export default async function AppraisalRecordPage({ params, searchParams }: { params: Promise<{ appraisalId: string }>; searchParams: Promise<{ saved?: string; err?: string; signed?: string }> }) {
  const { orgId } = await requireHrOrg();
  const { appraisalId } = await params;
  const sp = await searchParams;
  const a = await getAppraisal(orgId, appraisalId);
  if (!a) notFound();
  const items = await listItems(orgId, appraisalId);
  const ratings = Array.from({ length: a.ratingMax }, (_, i) => i + 1);
  const locked = a.status === "completed" || a.status === "acknowledged";
  const next = NEXT_STATUS[a.status];
  const objectives = items.filter((i) => i.kind === "objective");
  const competencies = items.filter((i) => i.kind === "competency");

  const ItemCard = (i: (typeof items)[number]) => (
    <div key={i.id} className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium text-sm">{i.title}{i.weight != null && <span className="text-xs font-normal" style={{ color: "var(--muted)" }}> · {i.weight}%</span>}</div>
          {i.description && <p className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{i.description}</p>}
          {i.target && <p className="text-xs mt-0.5"><span className="label inline">Target:</span> {i.target}</p>}
        </div>
        {!locked && (
          <form action={deleteAppraisalItemAction}><input type="hidden" name="itemId" value={i.id} /><input type="hidden" name="appraisalId" value={a.id} /><button className="btn btn-sm" type="submit" title="Remove">✕</button></form>
        )}
      </div>
      <form action={updateAppraisalItemAction} className="grid sm:grid-cols-2 gap-2 mt-3">
        <input type="hidden" name="itemId" value={i.id} /><input type="hidden" name="appraisalId" value={a.id} />
        <Field label="Self rating"><select name="selfRating" defaultValue={i.selfRating ?? ""} disabled={locked} className="select select-sm"><option value="">—</option>{ratings.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
        <Field label="Manager rating"><select name="managerRating" defaultValue={i.managerRating ?? ""} disabled={locked} className="select select-sm"><option value="">—</option>{ratings.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
        <Field label="Self comment"><input name="selfComment" defaultValue={i.selfComment ?? ""} disabled={locked} className="input input-sm" /></Field>
        <Field label="Manager comment"><input name="managerComment" defaultValue={i.managerComment ?? ""} disabled={locked} className="input input-sm" /></Field>
        <div className="sm:col-span-2"><Field label="Result / evidence"><input name="result" defaultValue={i.result ?? ""} disabled={locked} className="input input-sm" /></Field></div>
        {!locked && <div className="sm:col-span-2"><button className="btn btn-sm" type="submit">Save line</button></div>}
      </form>
    </div>
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title={a.employeeName} subtitle={`${a.cycleName}${a.jobTitle ? ` · ${a.jobTitle}` : ""}`} actions={
        <div className="flex items-center gap-2">
          <Link href={`/print/appraisal/${a.id}`} className="btn btn-sm" target="_blank">Print</Link>
          <Link href={`/hr/appraisals/${a.cycleId}`} className="btn btn-sm">← Cycle</Link>
        </div>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.signed && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Signature applied.</div>}
      {sp.err === "nosig" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>No signature on file — add one in your <Link href="/profile" className="underline">profile</Link> first, then sign.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={a.status} />
        {a.archived && <Badge tone="muted">Archived</Badge>}
        {a.appraiserName && <span className="text-sm" style={{ color: "var(--muted)" }}>Appraiser: {a.appraiserName}</span>}
        {a.acknowledgedAt && <span className="text-sm" style={{ color: "var(--ok)" }}>Acknowledged {fmtDateTime(a.acknowledgedAt)}</span>}
        <div className="ml-auto flex items-center gap-2">
          {next && <form action={setAppraisalStatusAction}><input type="hidden" name="appraisalId" value={a.id} /><input type="hidden" name="status" value={next.to} /><button className="btn btn-sm btn-primary" type="submit">{next.label}</button></form>}
          {a.status === "completed" && <form action={acknowledgeAppraisalAction}><input type="hidden" name="appraisalId" value={a.id} /><button className="btn btn-sm" type="submit">Employee acknowledge</button></form>}
          <form action={archiveAppraisalAction}><input type="hidden" name="appraisalId" value={a.id} /><input type="hidden" name="archived" value={a.archived ? "0" : "1"} /><button className="btn btn-sm" type="submit">{a.archived ? "Unarchive" : "Archive"}</button></form>
          <form action={deleteAppraisalAction}><input type="hidden" name="appraisalId" value={a.id} /><input type="hidden" name="cycleId" value={a.cycleId} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-5">
        <Stat label="Self avg" value={a.selfAvg != null ? `${a.selfAvg}/${a.ratingMax}` : "—"} />
        <Stat label="Manager avg" value={a.managerAvg != null ? `${a.managerAvg}/${a.ratingMax}` : "—"} />
        <Stat label="Overall" value={a.overallRating != null ? `${a.overallRating}/${a.ratingMax}` : "—"} sub={ratingLabel(a.overallRating) ?? undefined} />
      </div>

      <SectionTitle>Objectives & goals</SectionTitle>
      <div className="space-y-3 mt-2 mb-4">{objectives.length === 0 ? <Empty title="No objectives yet" hint="Add goals being assessed below." /> : objectives.map(ItemCard)}</div>

      <SectionTitle>Competencies</SectionTitle>
      <div className="space-y-3 mt-2 mb-4">{competencies.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>No competencies added.</p> : competencies.map(ItemCard)}</div>

      {!locked && (
        <details className="card p-4 mb-5">
          <summary className="text-sm font-medium cursor-pointer">+ Add objective or competency</summary>
          <form action={addAppraisalItemAction} className="grid sm:grid-cols-2 gap-2 mt-3">
            <input type="hidden" name="appraisalId" value={a.id} />
            <Field label="Type"><select name="kind" defaultValue="objective" className="select select-sm"><option value="objective">Objective / goal</option><option value="competency">Competency</option></select></Field>
            <Field label="Title *"><input name="title" required className="input input-sm" placeholder="e.g. Complete field data collection" /></Field>
            <Field label="Weight %"><input name="weight" type="number" step="any" className="input input-sm" /></Field>
            <Field label="Target"><input name="target" className="input input-sm" placeholder="What good looks like" /></Field>
            <div className="sm:col-span-2"><Field label="Description"><input name="description" className="input input-sm" /></Field></div>
            <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Add</button></div>
          </form>
        </details>
      )}

      <SectionTitle>Overall review</SectionTitle>
      <form action={saveAppraisalReviewAction} className="card p-4 mt-2 grid gap-3">
        <input type="hidden" name="appraisalId" value={a.id} />
        <Field label="Manager / appraiser comments"><textarea name="managerComments" defaultValue={a.managerComments ?? ""} disabled={locked} rows={3} className="input" placeholder="Overall narrative assessment" /></Field>
        <Field label="Development plan (growth & training needs)"><textarea name="developmentPlan" defaultValue={a.developmentPlan ?? ""} disabled={locked} rows={3} className="input" /></Field>
        <Field label="Employee comments"><textarea name="employeeComments" defaultValue={a.employeeComments ?? ""} disabled={a.status === "acknowledged"} rows={2} className="input" placeholder="Employee's response" /></Field>
        <Field label="Director, HR comments / recommendation"><textarea name="hrComments" defaultValue={a.hrComments ?? ""} disabled={locked} rows={2} className="input" /></Field>
        <div className="grid sm:grid-cols-2 gap-3 items-end">
          <Field label={`Overall rating (1–${a.ratingMax}, blank = use manager average)`}><select name="overallRating" defaultValue={a.overallRating ?? ""} disabled={locked} className="select"><option value="">— (auto from manager average)</option>{ratings.map((r) => <option key={r} value={r}>{r} — {ratingLabel(r)}</option>)}</select></Field>
          {!locked && <div><button className="btn btn-primary" type="submit">Save review</button></div>}
        </div>
      </form>

      <SectionTitle>Sign-off</SectionTitle>
      <div className="card p-4 mt-2">
        <AppraisalSignatures a={a} caps={{ employee: true, appraiser: true, hr: true }} />
        <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>Signing applies the signer&apos;s saved signature (set one in your profile). HR may sign on behalf of any party.</p>
      </div>
    </div>
  );
}
