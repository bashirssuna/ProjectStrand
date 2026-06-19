import Link from "next/link";
import { requireStudiesOrg } from "./_guard";
import { q } from "@/server/db";
import { accessibleProjectIds } from "@/server/services/lab";
import { listStudies, studyStats, expiringApprovals } from "@/server/services/studies";
import { PageHeader, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { label } from "@/lib/enums";
import { fmtDate } from "@/lib/format";

const TYPES = ["clinical_trial", "cohort", "observational", "other"];
const STATUSES = ["planning", "startup", "recruiting", "active", "follow_up", "closed", "suspended", "terminated"];

export default async function StudiesRegistry({ searchParams }: { searchParams: Promise<{ search?: string; projectId?: string; studyType?: string; status?: string; created?: string; deleted?: string }> }) {
  const { orgId, orgName, userId, isOrgAdmin, isSuperAdmin } = await requireStudiesOrg();
  const sp = await searchParams;
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const projectIds = await accessibleProjectIds(userId, orgId, isAdmin);
  const projects = await q<{ id: string; code: string; title: string }>(
    projectIds.length ? `SELECT id, code, title FROM project WHERE id IN (${projectIds.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY code` : `SELECT id, code, title FROM project WHERE false`, projectIds
  );
  const [rows, stats, expiring] = await Promise.all([
    listStudies(orgId, projectIds, { search: sp.search, projectId: sp.projectId, studyType: sp.studyType, status: sp.status }),
    studyStats(orgId, projectIds),
    expiringApprovals(orgId, projectIds, 60),
  ]);

  return (
    <div>
      <PageHeader title="Clinical trials & cohorts" subtitle={`Study management for ${orgName}`}
        actions={<Link href="/studies/new" className="btn btn-sm btn-primary">+ New study</Link>} />

      {sp.deleted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>Study deleted.</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Stat label="Studies" value={String(stats.total)} />
        <Stat label="Recruiting / active" value={String(stats.recruiting)} />
        <Stat label="Trials" value={String(stats.byType.find((t) => t.studyType === "clinical_trial")?.count ?? 0)} />
        <Stat label="Cohorts" value={String(stats.byType.find((t) => t.studyType === "cohort")?.count ?? 0)} />
      </div>

      {expiring.length > 0 && (
        <div className="card p-4 mb-5" style={{ borderColor: "var(--warn)" }}>
          <div className="text-sm font-medium mb-2" style={{ color: "var(--warn)" }}>⚠ Approvals expiring soon ({expiring.length})</div>
          <div className="space-y-1">
            {expiring.slice(0, 6).map((a) => (
              <div key={a.id} className="text-sm flex justify-between gap-2">
                <Link href={`/studies/${a.studyId}`} className="hover:underline">{a.studyTitle} — {label(a.authority)}{a.referenceNumber ? ` (${a.referenceNumber})` : ""}</Link>
                <span className="tabular-nums whitespace-nowrap" style={{ color: a.daysLeft < 0 ? "var(--danger)" : "var(--warn)" }}>{a.daysLeft < 0 ? `expired ${-a.daysLeft}d ago` : `${a.daysLeft}d left`} · {fmtDate(a.expiryDate)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <form className="card p-4 mb-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
        <div className="lg:col-span-2"><Field label="Search (title, code, registration…)"><input name="search" defaultValue={sp.search ?? ""} className="input" placeholder="Type to search" /></Field></div>
        <Field label="Project"><select name="projectId" defaultValue={sp.projectId ?? ""} className="select"><option value="">All</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></Field>
        <Field label="Type"><select name="studyType" defaultValue={sp.studyType ?? ""} className="select"><option value="">All</option>{TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select"><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <div className="flex gap-2"><button className="btn btn-sm btn-primary" type="submit">Apply</button><Link href="/studies" className="btn btn-sm">Reset</Link></div>
      </form>

      {rows.length === 0 ? (
        <Empty title="No studies yet" hint="Register a clinical trial or cohort to start tracking sites, approvals, enrollment, and milestones." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Study</th><th className="th text-left">Type</th><th className="th text-left">Project</th>
              <th className="th text-left">PI</th><th className="th text-left">Enrolled</th><th className="th text-left">Status</th><th className="th" />
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="td"><Link href={`/studies/${r.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{r.code ? <span className="font-mono text-xs mr-1">{r.code}</span> : null}{r.title}</Link>{r.expiringApprovals > 0 && <Badge tone="warn">approval expiring</Badge>}</td>
                  <td className="td">{label(r.studyType)}{r.phase ? ` · ${r.phase}` : ""}</td>
                  <td className="td">{r.projectCode ?? "—"}</td>
                  <td className="td">{r.piName ?? "—"}</td>
                  <td className="td tabular-nums">{r.enrolled}{r.targetEnrollment ? ` / ${r.targetEnrollment}` : ""}</td>
                  <td className="td"><StatusBadge status={r.status} /></td>
                  <td className="td text-right"><Link href={`/studies/${r.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
