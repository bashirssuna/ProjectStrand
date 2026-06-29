import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { one } from "@/server/db";
import { listReports, reportStats } from "@/server/services/whistleblower";
import { PageHeader, SectionTitle, Field, Stat, StatusBadge, Badge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";

const sevTone = (s: string) => (s === "critical" ? "danger" : s === "high" ? "warn" : s === "low" ? "muted" : "info");

export default async function WhistleblowerPage({ searchParams }: { searchParams: Promise<{ status?: string; search?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
  const [reports, stats, org] = await Promise.all([
    listReports(orgId, { status: sp.status, search: sp.search }),
    reportStats(orgId),
    one<{ slug: string }>(`SELECT slug FROM organization WHERE id=$1`, [orgId]),
  ]);
  const publicPath = `/report/${org?.slug ?? ""}`;

  return (
    <div className="max-w-5xl">
      <PageHeader title="Whistleblower reports" subtitle={`Confidential reporting & ethics cases for ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />

      <div className="card p-3 mb-4 text-sm flex flex-wrap items-center gap-2" style={{ background: "color-mix(in srgb, var(--brand) 6%, transparent)" }}>
        <span style={{ color: "var(--muted)" }}>Public reporting link:</span>
        <code style={{ fontWeight: 600 }}>{publicPath}</code>
        <Link href={publicPath} target="_blank" className="btn btn-sm ml-auto">Open intake form ↗</Link>
        <Link href="/report/track" target="_blank" className="btn btn-sm">Follow-up page ↗</Link>
      </div>
      <p className="text-xs mb-4" style={{ color: "var(--muted)" }}>Publish the intake link to staff and stakeholders. Reports here are confidential — internal notes are never shown to reporters.</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Open" value={String(stats.open)} tone={stats.open ? "warn" : undefined} />
        <Stat label="Investigating" value={String(stats.investigating)} />
        <Stat label="Critical & open" value={String(stats.critical)} tone={stats.critical ? "danger" : undefined} />
        <Stat label="Closed" value={String(stats.closed)} />
      </div>

      <form className="card p-3 mb-4 flex flex-wrap gap-3 items-end">
        <Field label="Status"><select name="status" defaultValue={sp.status ?? ""} className="select select-sm"><option value="">All</option><option value="open">Open</option><option value="closed">Closed</option></select></Field>
        <Field label="Search"><input name="search" defaultValue={sp.search ?? ""} className="input input-sm" placeholder="Title or code" /></Field>
        <button className="btn btn-sm btn-primary" type="submit">Apply</button>
        <Link href="/finance/whistleblower" className="btn btn-sm">Reset</Link>
      </form>

      <SectionTitle>Reports</SectionTitle>
      <div className="mt-2">
        {reports.length === 0 ? <Empty title="No reports" hint="Submissions through the public intake link will appear here." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Report</th><th className="th text-left">Category</th><th className="th text-left">Severity</th><th className="th text-left">Handler</th><th className="th text-left">Received</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id}>
                    <td className="td"><div className="font-medium">{r.title}</div><div className="text-xs font-mono" style={{ color: "var(--muted)" }}>{r.trackingCode}{r.isAnonymous ? " · anonymous" : ""}{r.retaliationConcern ? " · retaliation flag" : ""}</div></td>
                    <td className="td">{r.category ?? "—"}</td>
                    <td className="td"><Badge tone={sevTone(r.severity)}>{label(r.severity)}</Badge></td>
                    <td className="td">{r.handler ?? "—"}</td>
                    <td className="td whitespace-nowrap">{fmtDate(r.createdAt)}</td>
                    <td className="td"><StatusBadge status={r.status} /></td>
                    <td className="td text-right"><Link href={`/finance/whistleblower/${r.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
