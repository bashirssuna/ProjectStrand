import Link from "next/link";
import { requireLabOrg } from "../_guard";
import { q } from "@/server/db";
import { ensureSampleTypes, accessibleProjectIds, listSamples, canSeePII, maskName, formatAge } from "@/server/services/lab";
import { PageHeader, Field, Badge, StatusBadge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

const STATUSES = ["active", "depleted", "quarantined", "in_transit", "disposed"];

export default async function SampleRegistry({ searchParams }: { searchParams: Promise<{ search?: string; projectId?: string; sampleTypeId?: string; status?: string; dateFrom?: string; dateTo?: string; abnormal?: string }> }) {
  const { orgId, userId, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  await ensureSampleTypes(orgId);
  const sp = await searchParams;
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const seePII = canSeePII(isOrgAdmin, isSuperAdmin);
  const projectIds = await accessibleProjectIds(userId, orgId, isAdmin);
  const projects = await q<{ id: string; code: string; title: string }>(
    projectIds.length ? `SELECT id, code, title FROM project WHERE id IN (${projectIds.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY code` : `SELECT id, code, title FROM project WHERE false`, projectIds
  );
  const types = await q<{ id: string; category: string; type: string }>(`SELECT id, category, type FROM lab_sample_type WHERE org_id=$1 ORDER BY category, type`, [orgId]);

  const rows = await listSamples(orgId, projectIds, {
    search: sp.search, projectId: sp.projectId, sampleTypeId: sp.sampleTypeId, status: sp.status,
    dateFrom: sp.dateFrom, dateTo: sp.dateTo, abnormal: sp.abnormal === "1",
  });

  return (
    <div>
      <PageHeader title="Sample registry" subtitle={`${rows.length} sample${rows.length === 1 ? "" : "s"}`}
        actions={<div className="flex gap-2"><Link href="/lab" className="btn btn-sm">← Laboratory</Link><Link href="/lab/samples/new" className="btn btn-sm btn-primary">+ Register sample</Link></div>} />

      <form className="card p-4 mb-5 grid sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
        <div className="lg:col-span-2"><Field label="Search (sample ID, study ID…)"><input name="search" defaultValue={sp.search ?? ""} className="input" placeholder="Type to search" /></Field></div>
        <Field label="Project"><select name="projectId" defaultValue={sp.projectId ?? ""} className="select"><option value="">All</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code}</option>)}</select></Field>
        <Field label="Sample type"><select name="sampleTypeId" defaultValue={sp.sampleTypeId ?? ""} className="select"><option value="">All</option>{types.map((t) => <option key={t.id} value={t.id}>{t.type}</option>)}</select></Field>
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select"><option value="">All</option>{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
        <Field label="Collected from"><input type="date" name="dateFrom" defaultValue={sp.dateFrom ?? ""} className="input" /></Field>
        <Field label="Collected to"><input type="date" name="dateTo" defaultValue={sp.dateTo ?? ""} className="input" /></Field>
        <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" name="abnormal" value="1" defaultChecked={sp.abnormal === "1"} /> Only abnormal</label>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
          <button className="btn btn-sm btn-primary" type="submit">Apply filters</button>
          <Link href="/lab/samples" className="btn btn-sm">Reset</Link>
        </div>
      </form>

      {rows.length === 0 ? (
        <Empty title="No samples match" hint="Adjust the filters, or register a new sample." />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Sample ID</th><th className="th text-left">Study ID</th>
              <th className="th text-left">Participant</th><th className="th text-left">Age</th>
              <th className="th text-left">Type</th><th className="th text-left">Project</th>
              <th className="th text-left">Collected</th><th className="th text-left">Storage</th>
              <th className="th text-left">Status</th><th className="th" />
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="td font-mono text-xs"><Link href={`/lab/samples/${r.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{r.sampleCode}</Link></td>
                  <td className="td">{r.studyId ?? "—"}</td>
                  <td className="td">{maskName(r.participantName, seePII)}</td>
                  <td className="td whitespace-nowrap">{formatAge(r.ageYears, r.ageMonths)}</td>
                  <td className="td">{r.typeName ?? "—"}{r.abnormalities ? <Badge tone="warn">abnormal</Badge> : ""}</td>
                  <td className="td">{r.projectCode ?? "—"}</td>
                  <td className="td whitespace-nowrap">{fmtDate(r.collectionDate)}</td>
                  <td className="td text-xs">{r.storageEquipment ? `${r.storageEquipment}${r.storageShelf ? ` / ${r.storageShelf}` : ""}` : "—"}</td>
                  <td className="td"><StatusBadge status={r.status} /></td>
                  <td className="td text-right whitespace-nowrap"><Link href={`/lab/samples/${r.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>View →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!seePII && <p className="text-xs mt-3" style={{ color: "var(--muted)" }}>Participant names are hidden for your role — work by Study ID and age. Open a sample to request a name reveal if you are authorised.</p>}
    </div>
  );
}
