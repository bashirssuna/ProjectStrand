import Link from "next/link";
import { redirect } from "next/navigation";
import { requirePortalEmployee } from "../../_guard";
import { getAppraisal, listItems, ratingLabel } from "@/server/services/appraisals";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Badge, Empty } from "@/components/ui";
import { AppraisalSignatures } from "@/components/appraisal-signatures";
import { label } from "@/lib/enums";
import { updateAppraisalItemAction, saveAppraisalReviewAction, archiveAppraisalAction, deleteAppraisalAction } from "@/app/actions";

export default async function PortalAppraisalDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; signed?: string; err?: string }> }) {
  const { orgId, employeeId } = await requirePortalEmployee();
  const { id } = await params;
  const sp = await searchParams;
  const a = await getAppraisal(orgId, id);
  if (!a) redirect("/portal/appraisals");
  const isAppraisee = a.employeeId === employeeId;
  const isAppraiser = a.appraiserEmployeeId === employeeId;
  if (!isAppraisee && !isAppraiser) redirect("/portal/appraisals");

  const items = await listItems(orgId, id);
  const objectives = items.filter((i) => i.kind === "objective");
  const competencies = items.filter((i) => i.kind === "competency");
  const ratings = Array.from({ length: a.ratingMax || 5 }, (_, i) => i + 1);
  const frozen = ["completed", "acknowledged"].includes(a.status);
  const selfEditable = isAppraisee && !frozen;
  const mgrEditable = isAppraiser && !frozen;

  const ratingCell = (v: number | null) => (v != null ? `${v} — ${ratingLabel(v)}` : "—");

  const objectiveRow = (i: typeof items[number], idx: number) => (
    <div key={i.id} className="card p-3">
      <div className="flex items-start justify-between gap-2">
        <div><div className="font-medium text-sm">{idx + 1}. {i.title}</div>{i.target && <div className="text-xs" style={{ color: "var(--muted)" }}>Target: {i.target}</div>}</div>
        <div className="text-xs text-right" style={{ color: "var(--muted)" }}>Appraisee: {ratingCell(i.selfRating)}<br />Appraiser: {ratingCell(i.managerRating)}</div>
      </div>
      {selfEditable && (
        <form action={updateAppraisalItemAction} className="grid sm:grid-cols-2 gap-2 mt-2">
          <input type="hidden" name="itemId" value={i.id} /><input type="hidden" name="appraisalId" value={a.id} /><input type="hidden" name="returnTo" value="portal" />
          <Field label="Your rating"><select name="selfRating" defaultValue={i.selfRating ?? ""} className="select select-sm"><option value="">—</option>{ratings.map((r) => <option key={r} value={r}>{r} — {ratingLabel(r)}</option>)}</select></Field>
          <Field label="Your comment"><input name="selfComment" defaultValue={i.selfComment ?? ""} className="input input-sm" /></Field>
          <div className="sm:col-span-2"><button className="btn btn-sm" type="submit">Save</button></div>
        </form>
      )}
      {mgrEditable && (
        <form action={updateAppraisalItemAction} className="grid sm:grid-cols-2 gap-2 mt-2">
          <input type="hidden" name="itemId" value={i.id} /><input type="hidden" name="appraisalId" value={a.id} /><input type="hidden" name="returnTo" value="portal" />
          <Field label="Appraiser rating"><select name="managerRating" defaultValue={i.managerRating ?? ""} className="select select-sm"><option value="">—</option>{ratings.map((r) => <option key={r} value={r}>{r} — {ratingLabel(r)}</option>)}</select></Field>
          <Field label="Appraiser comment"><input name="managerComment" defaultValue={i.managerComment ?? ""} className="input input-sm" /></Field>
          <div className="sm:col-span-2"><Field label="Result / evidence"><input name="result" defaultValue={i.result ?? ""} className="input input-sm" /></Field></div>
          <div className="sm:col-span-2"><button className="btn btn-sm" type="submit">Save</button></div>
        </form>
      )}
    </div>
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title={a.cycleName} subtitle={`Appraisal for ${a.employeeName}${a.jobTitle ? ` · ${a.jobTitle}` : ""}`} actions={
        <div className="flex items-center gap-2">
          <Link href={`/print/appraisal/${a.id}`} className="btn btn-sm" target="_blank">Print</Link>
          <Link href="/portal/appraisals" className="btn btn-sm">← Back</Link>
        </div>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.signed && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Signature applied.</div>}
      {sp.err === "nosig" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>No signature on file — add one in your <Link href="/portal/profile" className="underline">profile</Link>, then sign.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={a.status} />
        <Badge tone="info">{isAppraisee ? "You are the appraisee" : "You are the appraiser"}</Badge>
        {a.appraiserName && <span className="text-sm" style={{ color: "var(--muted)" }}>Appraiser: {a.appraiserName}</span>}
        {isAppraiser && (
          <div className="ml-auto flex items-center gap-2">
            <form action={archiveAppraisalAction}><input type="hidden" name="appraisalId" value={a.id} /><input type="hidden" name="archived" value={a.archived ? "0" : "1"} /><input type="hidden" name="returnTo" value="portal" /><button className="btn btn-sm" type="submit">{a.archived ? "Unarchive" : "Archive"}</button></form>
            <form action={deleteAppraisalAction}><input type="hidden" name="appraisalId" value={a.id} /><input type="hidden" name="returnTo" value="portal" /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3 mb-5">
        <Stat label="Self average" value={a.selfAvg != null ? String(a.selfAvg) : "—"} />
        <Stat label="Appraiser average" value={a.managerAvg != null ? String(a.managerAvg) : "—"} />
        <Stat label="Overall" value={a.overallRating != null ? String(a.overallRating) : "—"} sub={ratingLabel(a.overallRating) ?? undefined} />
      </div>

      <SectionTitle>Job performance</SectionTitle>
      <div className="space-y-2 mt-2 mb-5">{objectives.length === 0 ? <Empty title="No objectives" hint="HR will add the agreed objectives." /> : objectives.map((o, idx) => objectiveRow(o, idx))}</div>

      {competencies.length > 0 && (
        <>
          <SectionTitle>Core competencies</SectionTitle>
          <div className="space-y-2 mt-2 mb-5">{competencies.map((c, idx) => objectiveRow(c, idx))}</div>
        </>
      )}

      {/* Comments */}
      <SectionTitle>Comments</SectionTitle>
      <div className="card p-4 mt-2 mb-5">
        {isAppraisee && (
          <form action={saveAppraisalReviewAction} className="mb-3">
            <input type="hidden" name="appraisalId" value={a.id} /><input type="hidden" name="returnTo" value="portal" />
            <Field label="Your comments (appraisee)"><textarea name="employeeComments" defaultValue={a.employeeComments ?? ""} rows={3} className="input" disabled={a.status === "acknowledged"} /></Field>
            {a.status !== "acknowledged" && <div className="mt-2"><button className="btn btn-sm" type="submit">Save my comments</button></div>}
          </form>
        )}
        {isAppraiser && (
          <form action={saveAppraisalReviewAction}>
            <input type="hidden" name="appraisalId" value={a.id} /><input type="hidden" name="returnTo" value="portal" />
            <div className="grid gap-3">
              <Field label="Appraiser comments"><textarea name="managerComments" defaultValue={a.managerComments ?? ""} rows={2} className="input" disabled={frozen} /></Field>
              <Field label="Action plan to improve performance"><textarea name="developmentPlan" defaultValue={a.developmentPlan ?? ""} rows={2} className="input" disabled={frozen} /></Field>
              <Field label={`Overall rating (blank = auto from average)`}><select name="overallRating" defaultValue={a.overallRating ?? ""} className="select" disabled={frozen}><option value="">— (auto)</option>{ratings.map((r) => <option key={r} value={r}>{r} — {ratingLabel(r)}</option>)}</select></Field>
            </div>
            {!frozen && <div className="mt-2"><button className="btn btn-sm" type="submit">Save review</button></div>}
          </form>
        )}
        {!isAppraisee && a.employeeComments && <div className="text-sm mt-2"><span className="label">Appraisee comments</span><p className="whitespace-pre-wrap">{a.employeeComments}</p></div>}
        {!isAppraiser && a.managerComments && <div className="text-sm mt-2"><span className="label">Appraiser comments</span><p className="whitespace-pre-wrap">{a.managerComments}</p></div>}
      </div>

      {/* Sign-off */}
      <SectionTitle>Sign-off</SectionTitle>
      <div className="card p-4 mt-2">
        <AppraisalSignatures a={a} caps={{ employee: isAppraisee, appraiser: isAppraiser }} returnTo="portal" />
        <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>Signing applies your saved signature. Set one under <Link href="/portal/profile" className="underline">profile</Link> if you haven&apos;t.</p>
      </div>
    </div>
  );
}
