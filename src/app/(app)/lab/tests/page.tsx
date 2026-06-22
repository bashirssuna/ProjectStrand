import Link from "next/link";
import { requireLabOrg } from "../_guard";
import { q } from "@/server/db";
import { accessibleProjectIds } from "@/server/services/lab";
import { listTests, testStats, listAssays } from "@/server/services/tests";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { addAssayAction, setAssayStatusAction, updateTestStatusAction } from "@/app/actions";

const STATUSES = ["requested", "in_progress", "completed", "cancelled", "failed"];
const CATEGORIES = ["Molecular", "Serology", "Hematology", "Microscopy", "Chemistry", "Other"];
const tone = (s: string) => (s === "completed" ? "ok" : s === "in_progress" ? "warn" : s === "failed" ? "danger" : s === "cancelled" ? "muted" : "info") as "ok" | "warn" | "danger" | "muted" | "info";

export default async function TestWorklist({ searchParams }: { searchParams: Promise<{ status?: string; assayId?: string; projectId?: string; search?: string; assay?: string; result?: string; removed?: string; err?: string }> }) {
  const { orgId, orgName, userId, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const sp = await searchParams;
  const projectIds = await accessibleProjectIds(userId, orgId, isAdmin);
  const [rows, stats, assays, allAssays, projects] = await Promise.all([
    listTests(orgId, projectIds, { status: sp.status, assayId: sp.assayId, projectId: sp.projectId, search: sp.search }),
    testStats(orgId, projectIds),
    listAssays(orgId),
    isAdmin ? listAssays(orgId, true) : Promise.resolve([]),
    projectIds.length ? q<{ id: string; code: string }>(`SELECT id, code FROM project WHERE id IN (${projectIds.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY code`, projectIds) : Promise.resolve([] as { id: string; code: string }[]),
  ]);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Test worklist" subtitle={`Assays & results across ${orgName}`} actions={<Link href="/lab" className="btn btn-sm">← Laboratory</Link>} />
      {sp.assay && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Assay catalogue updated.</div>}
      {sp.result && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Result recorded.</div>}
      {sp.err === "forbidden" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Only lab managers can manage the assay catalogue.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Requested" value={String(stats.requested)} tone={stats.requested > 0 ? "info" : undefined} />
        <Stat label="In progress" value={String(stats.inProgress)} tone={stats.inProgress > 0 ? "warn" : undefined} />
        <Stat label="Completed" value={String(stats.completed)} />
        <Stat label="Total" value={String(stats.total)} />
      </div>

      <form className="card p-4 mb-5 grid sm:grid-cols-4 gap-3 items-end">
        <Field label="Search"><input name="search" defaultValue={sp.search ?? ""} className="input" placeholder="Sample, study ID or assay" /></Field>
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select"><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <Field label="Assay"><select name="assayId" defaultValue={sp.assayId ?? ""} className="select"><option value="">All</option>{assays.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <div className="flex gap-2"><button className="btn btn-sm btn-primary" type="submit">Apply</button><Link href="/lab/tests" className="btn btn-sm">Reset</Link></div>
      </form>

      {rows.length === 0 ? (
        <Empty title="No tests" hint="Order tests from a sample's page; they appear here as a worklist." />
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Sample</th><th className="th text-left">Study ID</th><th className="th text-left">Assay</th><th className="th text-left">Requested</th><th className="th text-left">Status</th><th className="th text-left">Result</th><th className="th" /></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id}>
                  <td className="td"><Link href={`/lab/samples/${t.sampleId}`} className="font-mono text-xs hover:underline" style={{ color: "var(--brand)" }}>{t.sampleCode}</Link>{t.projectCode ? <span className="text-xs" style={{ color: "var(--muted)" }}> · {t.projectCode}</span> : null}</td>
                  <td className="td">{t.studyId ?? "—"}</td>
                  <td className="td">{t.assay ?? "—"}</td>
                  <td className="td whitespace-nowrap">{t.requestedDate ? fmtDate(t.requestedDate) : "—"}</td>
                  <td className="td"><Badge tone={tone(t.status)}>{label(t.status)}</Badge></td>
                  <td className="td">{t.result ?? ""}{t.interpretation ? <span style={{ color: "var(--muted)" }}> ({label(t.interpretation)})</span> : ""}</td>
                  <td className="td text-right whitespace-nowrap">
                    {t.status === "requested" && <form action={updateTestStatusAction} className="inline mr-2"><input type="hidden" name="testId" value={t.id} /><input type="hidden" name="status" value="in_progress" /><input type="hidden" name="back" value="tests" /><button className="text-xs hover:underline" type="submit" style={{ color: "var(--brand)" }}>start</button></form>}
                    <Link href={`/lab/samples/${t.sampleId}`} className="text-xs hover:underline" style={{ color: "var(--brand)" }}>open →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Assay catalogue (managers) */}
      {isAdmin && (
        <div className="card p-4">
          <SectionTitle>Assay catalogue</SectionTitle>
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>The list of tests your lab offers. Assays typed directly on a sample are added here automatically.</p>
          {allAssays.length > 0 && (
            <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
              <thead><tr><th className="th text-left">Assay</th><th className="th text-left">Category</th><th className="th text-left">Method</th><th className="th text-left">Unit</th><th className="th text-left">TAT</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>{allAssays.map((a) => (
                <tr key={a.id}><td className="td">{a.name}</td><td className="td">{a.category ?? "—"}</td><td className="td">{a.method ?? "—"}</td><td className="td">{a.unit ?? "—"}</td><td className="td">{a.turnaroundDays != null ? `${a.turnaroundDays}d` : "—"}</td>
                  <td className="td">{a.status === "active" ? <Badge tone="ok">active</Badge> : <Badge tone="muted">inactive</Badge>}</td>
                  <td className="td text-right"><form action={setAssayStatusAction} className="inline"><input type="hidden" name="assayId" value={a.id} /><input type="hidden" name="status" value={a.status === "active" ? "inactive" : "active"} /><button className="text-xs hover:underline" type="submit" style={{ color: "var(--brand)" }}>{a.status === "active" ? "deactivate" : "activate"}</button></form></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          <form action={addAssayAction} className="grid sm:grid-cols-5 gap-2 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
            <Field label="Assay name"><input name="name" required className="input" placeholder="e.g. Malaria RDT" /></Field>
            <Field label="Category"><select name="category" className="select"><option value="">—</option>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
            <Field label="Default method"><input name="method" className="input" placeholder="optional" /></Field>
            <Field label="Result unit"><input name="unit" className="input" placeholder="e.g. /µL" /></Field>
            <div className="flex gap-2 items-end"><Field label="TAT (days)"><input type="number" min={0} name="turnaroundDays" className="input" style={{ width: 80 }} /></Field><button className="btn btn-sm btn-primary" type="submit">Add</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
