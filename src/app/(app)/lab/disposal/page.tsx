import Link from "next/link";
import { requireLabOrg } from "../_guard";
import { q } from "@/server/db";
import { accessibleProjectIds, listDisposable } from "@/server/services/lab";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { bulkDisposeAction } from "@/app/actions";

const METHODS = ["Incineration", "Autoclave", "Chemical treatment", "Biohazard waste", "Return to source", "Other"];

export default async function Disposal({ searchParams }: { searchParams: Promise<{ projectId?: string; studyId?: string; sampleTypeId?: string; search?: string; disposed?: string; err?: string }> }) {
  const { orgId, orgName, userId, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const sp = await searchParams;

  if (!isAdmin) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Sample disposal" subtitle={orgName} actions={<Link href="/lab/samples" className="btn btn-sm">← Registry</Link>} />
        <Empty title="Managers only" hint="Sample disposal is restricted to lab managers. Ask a manager to dispose samples, or dispose a single sample from its own page if you have rights." />
      </div>
    );
  }

  const projectIds = await accessibleProjectIds(userId, orgId, true);
  const filters = { projectId: sp.projectId, studyId: sp.studyId, sampleTypeId: sp.sampleTypeId, search: sp.search };
  const [rows, projects, types] = await Promise.all([
    listDisposable(orgId, projectIds, filters),
    projectIds.length ? q<{ id: string; code: string }>(`SELECT id, code FROM project WHERE id IN (${projectIds.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY code`, projectIds) : Promise.resolve([] as { id: string; code: string }[]),
    q<{ id: string; type: string; category: string }>(`SELECT id, type, category FROM lab_sample_type WHERE org_id=$1 ORDER BY category, type`, [orgId]),
  ]);
  const filtered = !!(sp.projectId || sp.studyId || sp.sampleTypeId || sp.search);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Sample disposal" subtitle={`Dispose samples in bulk — by type, participant or selection`} actions={<Link href="/lab/samples" className="btn btn-sm">← Registry</Link>} />
      {sp.disposed && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>{sp.disposed} sample{sp.disposed === "1" ? "" : "s"} disposed and recorded.</div>}
      {sp.err === "reason" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A disposal reason is required.</div>}
      {sp.err === "none" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>No samples were selected or matched the filter.</div>}
      {sp.err === "forbidden" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Only lab managers can dispose samples.</div>}

      {/* Filter */}
      <form className="card p-4 mb-5 grid sm:grid-cols-4 gap-3 items-end">
        <Field label="Project"><select name="projectId" defaultValue={sp.projectId ?? ""} className="select"><option value="">All</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></Field>
        <Field label="Sample type"><select name="sampleTypeId" defaultValue={sp.sampleTypeId ?? ""} className="select"><option value="">All</option>{types.map((t) => <option key={t.id} value={t.id}>{t.category} · {t.type}</option>)}</select></Field>
        <Field label="Study ID"><input name="studyId" defaultValue={sp.studyId ?? ""} className="input" placeholder="participant" /></Field>
        <div className="flex gap-2"><button className="btn btn-sm btn-primary" type="submit">Filter</button><Link href="/lab/disposal" className="btn btn-sm">Reset</Link></div>
      </form>

      {rows.length === 0 ? (
        <Empty title="No disposable samples" hint="No non-disposed samples match this filter." />
      ) : (
        <form action={bulkDisposeAction}>
          {/* carry the active filter so "dispose all matching" knows the set */}
          <input type="hidden" name="projectId" value={sp.projectId ?? ""} />
          <input type="hidden" name="sampleTypeId" value={sp.sampleTypeId ?? ""} />
          <input type="hidden" name="studyId" value={sp.studyId ?? ""} />
          <input type="hidden" name="search" value={sp.search ?? ""} />

          <div className="card overflow-x-auto mb-4">
            <table className="w-full text-sm">
              <thead><tr><th className="th" /><th className="th text-left">Sample</th><th className="th text-left">Type</th><th className="th text-left">Study ID</th><th className="th text-left">Visit</th><th className="th text-left">Collected</th><th className="th text-right">Remaining</th><th className="th text-left">Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="td"><input type="checkbox" name="sampleIds" value={r.id} /></td>
                    <td className="td"><span className="font-mono text-xs">{r.sampleCode}</span>{r.isAliquot && <Badge tone="muted">aliquot</Badge>}</td>
                    <td className="td">{r.typeName ?? "—"}</td>
                    <td className="td">{r.studyId ?? "—"}</td>
                    <td className="td">{r.visitLabel ?? "—"}</td>
                    <td className="td whitespace-nowrap">{fmtDate(r.collectionDate)}</td>
                    <td className="td text-right tabular-nums">{r.quantityRemaining != null ? `${r.quantityRemaining}${r.aliquotUnit ? ` ${r.aliquotUnit}` : ""}` : "—"}</td>
                    <td className="td"><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length >= 500 && <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Showing the first 500 matching samples; &ldquo;dispose all matching&rdquo; will still cover every sample that matches the filter.</p>}

          <div className="card p-4">
            <SectionTitle>Disposal record</SectionTitle>
            <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Tick samples to dispose a selection, or use &ldquo;dispose all matching&rdquo; to dispose every sample matching the current filter (e.g. all plasma aliquots for one participant). Each disposed sample records the date, method, reason, witness and your name, and shares one disposal batch.</p>
            <div className="grid sm:grid-cols-3 gap-3 mb-3">
              <Field label="Method"><select name="method" className="select">{METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</select></Field>
              <Field label="Reason (required)"><input name="reason" required className="input" placeholder="e.g. study closeout / consent withdrawn" /></Field>
              <Field label="Witness"><input name="witness" className="input" placeholder="optional" /></Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <ConfirmSubmit message="Dispose the ticked samples? This cannot be undone." name="mode" value="selected" className="btn btn-primary">Dispose selected</ConfirmSubmit>
              <ConfirmSubmit message={`Dispose ALL ${rows.length}${rows.length >= 500 ? "+" : ""} samples matching this filter? This cannot be undone.`} name="mode" value="all" className="btn" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{filtered ? `Dispose all matching` : `Dispose all ${rows.length} shown`}</ConfirmSubmit>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
