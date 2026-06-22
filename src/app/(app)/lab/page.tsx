import Link from "next/link";
import { requireLabOrg } from "./_guard";
import { q } from "@/server/db";
import { ensureSampleTypes, accessibleProjectIds, labStats } from "@/server/services/lab";
import { PageHeader, SectionTitle, Stat, Empty, Badge, StatusBadge, Field } from "@/components/ui";
import { label, } from "@/lib/enums";
import { fmtDateTime } from "@/lib/format";
import { setSampleTypeMaxAction } from "@/app/actions";
import { freezerStats } from "@/server/services/freezers";
import { testStats } from "@/server/services/tests";

const PALETTE = ["#9a6a2f", "#c79a4b", "#5b8c7b", "#7b6ca8", "#b56b6b", "#6b8cb5", "#8ca86b", "#a8856b", "#6ba8a0", "#a86b95", "#7d8a99", "#caa46a"];
function slicePath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

export default async function LabDashboard({ searchParams }: { searchParams: Promise<{ projectId?: string; ftset?: string }> }) {
  const { orgId, orgName, userId, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  await ensureSampleTypes(orgId);
  const sp = await searchParams;
  const isAdmin = isOrgAdmin || isSuperAdmin;
  let projectIds = await accessibleProjectIds(userId, orgId, isAdmin);
  const projects = await q<{ id: string; code: string; title: string }>(
    projectIds.length ? `SELECT id, code, title FROM project WHERE id IN (${projectIds.map((_, i) => `$${i + 1}`).join(",")}) ORDER BY code` : `SELECT id, code, title FROM project WHERE false`, projectIds
  );
  if (sp.projectId && projectIds.includes(sp.projectId)) projectIds = [sp.projectId];

  const s = await labStats(orgId, projectIds);
  const monthDelta = s.collectedThisMonth - s.collectedLastMonth;

  // donut slices for sample-type distribution
  const slices = s.byType.map((t, i) => ({ label: t.type, value: t.count, color: PALETTE[i % PALETTE.length] }));
  const totalTyped = slices.reduce((a, b) => a + b.value, 0);
  const size = 200, cx = size / 2, cy = size / 2, r = size / 2 - 4;
  let acc = 0;
  const arcs = slices.map((sl) => {
    const a0 = totalTyped > 0 ? (acc / totalTyped) * 2 * Math.PI : 0; acc += sl.value;
    const a1 = totalTyped > 0 ? (acc / totalTyped) * 2 * Math.PI : 0;
    return { ...sl, d: slicePath(cx, cy, r, a0, slices.length === 1 ? a1 - 0.0001 : a1), share: totalTyped > 0 ? sl.value / totalTyped : 0 };
  });
  const maxFreezer = Math.max(1, ...s.byFreezer.map((f) => f.count));
  const ftTypes = isAdmin ? await q<{ id: string; category: string; type: string; maxFreezeThaw: number | null }>(
    `SELECT id, category, type, max_freeze_thaw AS "maxFreezeThaw" FROM lab_sample_type WHERE org_id=$1 ORDER BY category, type`, [orgId]) : [];
  const ftSet = sp.ftset === "1";
  const fz = await freezerStats(orgId);
  const ts = await testStats(orgId, projectIds);
  const pendingTests = ts.requested + ts.inProgress;

  return (
    <div>
      <PageHeader title="Laboratory" subtitle={`Biospecimen registry & chain of custody for ${orgName}`}
        actions={<div className="flex gap-2"><Link href="/lab/tests" className="btn btn-sm">Tests</Link><Link href="/lab/freezers" className="btn btn-sm">Freezers</Link><Link href="/lab/samples" className="btn btn-sm">All samples</Link><Link href="/lab/samples/new" className="btn btn-sm btn-primary">+ Register sample</Link></div>} />

      {pendingTests > 0 && (
        <Link href="/lab/tests" className="card p-3 mb-5 flex items-center justify-between gap-3 text-sm" style={{ borderColor: "var(--border)" }}>
          <span style={{ color: "var(--muted)" }}>Test worklist: <strong style={{ color: "var(--fg)" }}>{ts.requested}</strong> requested · <strong style={{ color: "var(--fg)" }}>{ts.inProgress}</strong> in progress.</span>
          <span style={{ color: "var(--brand)" }}>Open worklist →</span>
        </Link>
      )}

      {(fz.outOfRange > 0 || fz.openIncidents > 0) && (
        <Link href="/lab/freezers" className="card p-3 mb-5 flex items-center justify-between gap-3 text-sm" style={{ borderColor: fz.outOfRange > 0 || fz.criticalOpen > 0 ? "var(--danger)" : "var(--warn)" }}>
          <span style={{ color: fz.outOfRange > 0 || fz.criticalOpen > 0 ? "var(--danger)" : "var(--warn)" }}>
            Cold chain: {fz.outOfRange > 0 ? `${fz.outOfRange} freezer${fz.outOfRange === 1 ? "" : "s"} out of range` : "all in range"}{fz.openIncidents > 0 ? ` · ${fz.openIncidents} open incident${fz.openIncidents === 1 ? "" : "s"}${fz.criticalOpen > 0 ? ` (${fz.criticalOpen} critical)` : ""}` : ""}.
          </span>
          <span style={{ color: "var(--brand)" }}>Review →</span>
        </Link>
      )}

      {projects.length > 1 && (
        <form className="mb-5 flex items-end gap-2">
          <div><label className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Project</label>
            <select name="projectId" defaultValue={sp.projectId ?? ""} className="select" style={{ minWidth: 240 }}>
              <option value="">All my projects</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}
            </select>
          </div>
          <button className="btn btn-sm" type="submit">Apply</button>
        </form>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Active samples" value={String(s.totalActive)} sub={`${s.quarantined} quarantined`} tone={s.quarantined ? "warn" : undefined} />
        <Stat label="Collected this month" value={String(s.collectedThisMonth)} sub={monthDelta === 0 ? "same as last month" : `${monthDelta > 0 ? "+" : ""}${monthDelta} vs last month`} tone={monthDelta < 0 ? "warn" : undefined} />
        <Stat label="Pending aliquots" value={String(s.pendingAliquots)} sub="collected, not processed" />
        <Stat label="Retrievals (7 days)" value={String(s.recentRetrievals)} />
      </div>

      {s.totalActive === 0 && s.byStatus.length === 0 ? (
        <Empty title="No samples yet" hint="Register your first biospecimen to start building the registry and chain of custody." />
      ) : (
        <>
          <div className="grid lg:grid-cols-2 gap-4 mb-7">
            <div className="card p-4">
              <SectionTitle>Sample type distribution</SectionTitle>
              {arcs.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>No samples in storage.</p> : (
                <div className="flex flex-col sm:flex-row gap-4 items-center">
                  <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ flexShrink: 0 }} role="img" aria-label="Sample type distribution">
                    {arcs.map((a, i) => <path key={i} d={a.d} fill={a.color} stroke="var(--surface)" strokeWidth={1.5} />)}
                    <circle cx={cx} cy={cy} r={r * 0.56} fill="var(--surface)" />
                    <text x={cx} y={cy - 2} textAnchor="middle" style={{ fontSize: 11, fill: "var(--muted)" }}>In storage</text>
                    <text x={cx} y={cy + 14} textAnchor="middle" style={{ fontSize: 14, fontWeight: 600, fill: "var(--fg)" }}>{totalTyped}</text>
                  </svg>
                  <div className="w-full">
                    <table className="w-full text-sm"><tbody>
                      {arcs.map((a, i) => (
                        <tr key={i}>
                          <td className="td"><span style={{ display: "inline-block", width: 9, height: 9, borderRadius: 2, background: a.color, marginRight: 7 }} />{a.label}</td>
                          <td className="td text-right tabular-nums">{a.value}</td>
                          <td className="td text-right tabular-nums" style={{ color: "var(--muted)" }}>{Math.round(a.share * 100)}%</td>
                        </tr>
                      ))}
                    </tbody></table>
                  </div>
                </div>
              )}
            </div>

            <div className="card p-4">
              <SectionTitle>Storage occupancy by freezer</SectionTitle>
              {s.byFreezer.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>No stored samples yet.</p> : (
                <div className="space-y-2 mt-1">
                  {s.byFreezer.map((f, i) => (
                    <div key={i}>
                      <div className="flex justify-between text-xs mb-1"><span>{f.freezer}</span><span className="tabular-nums" style={{ color: "var(--muted)" }}>{f.count}</span></div>
                      <div style={{ height: 8, borderRadius: 4, background: "var(--border)" }}><div style={{ width: `${(f.count / maxFreezer) * 100}%`, height: "100%", borderRadius: 4, background: "var(--brand)" }} /></div>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4">
                <div className="text-xs mb-2" style={{ color: "var(--muted)" }}>By status</div>
                <div className="flex flex-wrap gap-2">
                  {s.byStatus.map((b, i) => <Badge key={i} tone={b.status === "active" ? "ok" : b.status === "quarantined" ? "warn" : b.status === "disposed" ? "muted" : "info"}>{label(b.status)}: {b.count}</Badge>)}
                </div>
              </div>
            </div>
          </div>

          <SectionTitle>Recent activity</SectionTitle>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Sample</th><th className="th text-left">Type</th><th className="th text-left">Status</th><th className="th text-left">Registered</th><th className="th" /></tr></thead>
              <tbody>
                {s.recent.map((rrow) => (
                  <tr key={rrow.id}>
                    <td className="td font-mono text-xs">{rrow.sampleCode}</td>
                    <td className="td">{rrow.typeName ?? "—"}</td>
                    <td className="td"><StatusBadge status={rrow.status} /></td>
                    <td className="td whitespace-nowrap">{fmtDateTime(rrow.createdAt)}</td>
                    <td className="td text-right"><Link href={`/lab/samples/${rrow.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {isAdmin && ftTypes.length > 0 && (
            <>
              <SectionTitle>Sample types &amp; freeze-thaw limits</SectionTitle>
              {ftSet && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Freeze-thaw limit updated.</div>}
              <div className="card p-4">
                <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Set the acceptable number of freeze-thaw cycles for each analyte. Samples at or above their limit are flagged in the registry. Leave blank for no limit.</p>
                <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-2">
                  {ftTypes.map((t) => (
                    <form key={t.id} action={setSampleTypeMaxAction} className="flex items-center gap-2">
                      <input type="hidden" name="typeId" value={t.id} />
                      <span className="text-sm flex-1 truncate" title={`${t.category} · ${t.type}`}><span style={{ color: "var(--muted)" }}>{t.category} · </span>{t.type}</span>
                      <input type="number" min={0} name="maxFreezeThaw" defaultValue={t.maxFreezeThaw ?? ""} className="input" style={{ width: 70, padding: "4px 8px" }} placeholder="—" />
                      <button className="btn btn-sm" type="submit">Save</button>
                    </form>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
