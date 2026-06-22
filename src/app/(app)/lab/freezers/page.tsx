import Link from "next/link";
import { requireLabOrg } from "../_guard";
import { listFreezers, freezerStats } from "@/server/services/freezers";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { createFreezerAction } from "@/app/actions";

const KINDS: [string, string][] = [["freezer_-80", "Freezer −80 °C"], ["freezer_-20", "Freezer −20 °C"], ["fridge_4", "Fridge 4 °C"], ["ln2", "Liquid nitrogen"], ["cold_room", "Cold room"], ["other", "Other"]];
const STATUSES = ["active", "maintenance", "decommissioned"];
const kindLabel = (k: string) => KINDS.find((x) => x[0] === k)?.[1] ?? label(k);

export default async function Freezers({ searchParams }: { searchParams: Promise<{ created?: string; deleted?: string; err?: string }> }) {
  const { orgId, orgName, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const sp = await searchParams;
  const [rows, stats] = await Promise.all([listFreezers(orgId), freezerStats(orgId)]);

  const rangeText = (mn: number | null, mx: number | null) => mn != null || mx != null ? `${mn ?? "−∞"} to ${mx ?? "∞"} °C` : "—";

  return (
    <div className="max-w-5xl">
      <PageHeader title="Freezers & cold chain" subtitle={`Temperature monitoring for ${orgName}`} actions={<Link href="/lab" className="btn btn-sm">← Laboratory</Link>} />
      {sp.deleted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)" }}>Freezer removed.</div>}
      {sp.err === "forbidden" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Only lab managers can manage the freezer register.</div>}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <Stat label="Freezers" value={String(stats.total)} />
        <Stat label="Out of range now" value={String(stats.outOfRange)} tone={stats.outOfRange > 0 ? "danger" : undefined} />
        <Stat label="Open incidents" value={String(stats.openIncidents)} tone={stats.openIncidents > 0 ? "warn" : undefined} />
        <Stat label="Critical open" value={String(stats.criticalOpen)} tone={stats.criticalOpen > 0 ? "danger" : undefined} />
      </div>

      {rows.length === 0 ? (
        <Empty title="No freezers registered" hint="Add your cold-storage units to start logging daily temperatures and incidents." />
      ) : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Unit</th><th className="th text-left">Type</th><th className="th text-left">Range</th><th className="th text-left">Last reading</th><th className="th text-left">Incidents</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td className="td"><Link href={`/lab/freezers/${f.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>{f.name}</Link>{f.location ? <div className="text-xs" style={{ color: "var(--muted)" }}>{f.location}</div> : null}</td>
                  <td className="td whitespace-nowrap">{kindLabel(f.kind)}</td>
                  <td className="td whitespace-nowrap text-xs">{rangeText(f.minTemp, f.maxTemp)}</td>
                  <td className="td whitespace-nowrap">
                    {f.lastTemp != null ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="tabular-nums" style={{ color: f.lastInRange === false ? "var(--danger)" : "inherit" }}>{f.lastTemp} °C</span>
                        {f.lastInRange === false ? <Badge tone="danger">out of range</Badge> : <Badge tone="ok">in range</Badge>}
                        <span className="text-xs" style={{ color: "var(--muted)" }}>{fmtDateTime(f.lastReadingAt!)}</span>
                      </span>
                    ) : <span style={{ color: "var(--muted)" }}>no readings</span>}
                  </td>
                  <td className="td">{f.openIncidents > 0 ? <Badge tone={f.criticalOpen > 0 ? "danger" : "warn"}>{f.openIncidents} open</Badge> : <span style={{ color: "var(--muted)" }}>—</span>}</td>
                  <td className="td"><StatusBadge status={f.status} /></td>
                  <td className="td text-right"><Link href={`/lab/freezers/${f.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin ? (
        <div className="card p-4">
          <SectionTitle>Register a freezer</SectionTitle>
          <form action={createFreezerAction} className="grid sm:grid-cols-3 gap-3">
            <Field label="Name / tag"><input name="name" required className="input" placeholder="e.g. FZR-01" /></Field>
            <Field label="Location"><input name="location" className="input" placeholder="e.g. Cold Room 1" /></Field>
            <Field label="Type"><select name="kind" defaultValue="freezer_-80" className="select">{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Set point (°C)"><input type="number" step="any" name="setPoint" className="input" placeholder="-80" /></Field>
            <Field label="Min acceptable (°C)"><input type="number" step="any" name="minTemp" className="input" placeholder="-90" /></Field>
            <Field label="Max acceptable (°C)"><input type="number" step="any" name="maxTemp" className="input" placeholder="-70" /></Field>
            <Field label="Status"><select name="status" defaultValue="active" className="select">{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
            <div className="sm:col-span-2"><Field label="Notes"><input name="notes" className="input" /></Field></div>
            <div><button className="btn btn-primary" type="submit">Add freezer</button></div>
          </form>
        </div>
      ) : (
        <p className="text-xs" style={{ color: "var(--muted)" }}>Lab managers register and configure freezers. You can record temperatures and log incidents from each freezer&apos;s page.</p>
      )}
    </div>
  );
}
