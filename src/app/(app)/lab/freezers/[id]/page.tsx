import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireLabOrg } from "../../_guard";
import { getFreezer, freezerTempLogs, freezerIncidents, freezerSamples, freezerSampleCount } from "@/server/services/freezers";
import { PageHeader, SectionTitle, Field, Badge, StatusBadge, Empty, Stat } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { ConfirmSubmit } from "@/components/confirm-submit";
import { recordTempAction, addFreezerIncidentAction, resolveFreezerIncidentAction, deleteFreezerIncidentAction, updateFreezerAction, deleteFreezerAction } from "@/app/actions";

const KINDS: [string, string][] = [["freezer_-80", "Freezer −80 °C"], ["freezer_-20", "Freezer −20 °C"], ["fridge_4", "Fridge 4 °C"], ["ln2", "Liquid nitrogen"], ["cold_room", "Cold room"], ["other", "Other"]];
const STATUSES = ["active", "maintenance", "decommissioned"];
const INC_KINDS = ["power_outage", "alarm", "excursion", "mechanical", "door_open", "defrost", "other"];
const SEVERITIES = ["info", "warning", "critical"];
const kindLabel = (k: string) => KINDS.find((x) => x[0] === k)?.[1] ?? label(k);
const sevTone = (s: string) => (s === "critical" ? "danger" : s === "warning" ? "warn" : "info") as "danger" | "warn" | "info";

export default async function FreezerDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string>> }) {
  const { id } = await params;
  const { orgId, isOrgAdmin, isSuperAdmin } = await requireLabOrg();
  const isAdmin = isOrgAdmin || isSuperAdmin;
  const sp = await searchParams;

  const f = await getFreezer(orgId, id);
  if (!f) notFound();
  const [logs, incidents, samples, sampleCount] = await Promise.all([freezerTempLogs(id, 60), freezerIncidents(id), freezerSamples(id, 200), freezerSampleCount(id)]);
  const latest = logs[0] ?? null;
  const openInc = incidents.filter((i) => !i.resolved).length;
  const atRisk = (latest && !latest.inRange) || openInc > 0;
  const now = new Date().toISOString().slice(0, 16);

  // Sparkline from the most recent readings (oldest -> newest).
  const series = [...logs].reverse();
  let spark: React.ReactNode = null;
  if (series.length >= 2) {
    const W = 620, H = 90, pad = 6;
    const temps = series.map((r) => r.temperature);
    const bounds = [...temps, ...(f.minTemp != null ? [f.minTemp] : []), ...(f.maxTemp != null ? [f.maxTemp] : [])];
    const lo = Math.min(...bounds), hi = Math.max(...bounds);
    const span = hi - lo || 1;
    const x = (i: number) => pad + (i / (series.length - 1)) * (W - 2 * pad);
    const y = (t: number) => pad + (1 - (t - lo) / span) * (H - 2 * pad);
    const linePts = series.map((r, i) => `${x(i).toFixed(1)},${y(r.temperature).toFixed(1)}`).join(" ");
    const bandTop = f.maxTemp != null ? y(f.maxTemp) : null;
    const bandBot = f.minTemp != null ? y(f.minTemp) : null;
    spark = (
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" style={{ display: "block" }}>
        {bandTop != null && bandBot != null && <rect x={0} y={bandTop} width={W} height={Math.max(0, bandBot - bandTop)} fill="var(--ok)" opacity={0.10} />}
        {bandTop != null && <line x1={0} x2={W} y1={bandTop} y2={bandTop} stroke="var(--ok)" strokeDasharray="4 3" opacity={0.5} />}
        {bandBot != null && <line x1={0} x2={W} y1={bandBot} y2={bandBot} stroke="var(--ok)" strokeDasharray="4 3" opacity={0.5} />}
        <polyline points={linePts} fill="none" stroke="var(--brand)" strokeWidth={1.5} />
        {series.map((r, i) => <circle key={i} cx={x(i)} cy={y(r.temperature)} r={2.5} fill={r.inRange ? "var(--brand)" : "var(--danger)"} />)}
      </svg>
    );
  }

  return (
    <div className="max-w-4xl">
      <PageHeader title={f.name} subtitle={`${kindLabel(f.kind)}${f.location ? ` · ${f.location}` : ""}`}
        actions={<div className="flex gap-2">
          {isAdmin && <form action={deleteFreezerAction} className="inline"><input type="hidden" name="freezerId" value={f.id} /><ConfirmSubmit message="Delete this freezer and all its temperature and incident logs?"><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button></ConfirmSubmit></form>}
          <Link href="/lab/freezers" className="btn btn-sm">← Freezers</Link>
        </div>} />
      {sp.created && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Freezer registered.</div>}
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.temp === "ok" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Reading logged — within range.</div>}
      {sp.temp === "out" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reading logged — <strong>out of range</strong>. Consider logging an incident below.</div>}
      {sp.incident && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Incident recorded.</div>}
      {sp.incresolved === "1" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Incident resolved.</div>}
      {sp.err === "forbidden" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Only lab managers can do that.</div>}

      {/* Headline */}
      <div className="card p-4 mb-5">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <StatusBadge status={f.status} />
          {latest && (latest.inRange ? <Badge tone="ok">last reading in range</Badge> : <Badge tone="danger">last reading out of range</Badge>)}
          {openInc > 0 && <Badge tone="warn">{openInc} open incident{openInc === 1 ? "" : "s"}</Badge>}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Set point" value={f.setPoint != null ? `${f.setPoint} °C` : "—"} />
          <Stat label="Acceptable range" value={f.minTemp != null || f.maxTemp != null ? `${f.minTemp ?? "−∞"} to ${f.maxTemp ?? "∞"} °C` : "—"} />
          <Stat label="Latest temp" value={latest ? `${latest.temperature} °C` : "—"} sub={latest ? fmtDateTime(latest.readingAt) : undefined} tone={latest && !latest.inRange ? "danger" : undefined} />
          <Stat label="Readings" value={String(logs.length)} />
        </div>
        {spark && <div className="mt-4">{spark}<div className="text-xs mt-1" style={{ color: "var(--muted)" }}>Recent readings (oldest → newest); shaded band is the acceptable range, red points are excursions.</div></div>}
        {f.notes && <p className="text-sm mt-3"><span style={{ color: "var(--muted)" }}>Notes: </span>{f.notes}</p>}
      </div>

      {/* Samples stored here */}
      <div className="card p-4 mb-5">
        <SectionTitle>Samples stored here ({sampleCount})</SectionTitle>
        {atRisk && sampleCount > 0 && (
          <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>
            {sampleCount} sample{sampleCount === 1 ? "" : "s"} may be affected — this freezer {latest && !latest.inRange ? "has an out-of-range reading" : ""}{latest && !latest.inRange && openInc > 0 ? " and " : ""}{openInc > 0 ? `has ${openInc} open incident${openInc === 1 ? "" : "s"}` : ""}. Review integrity before use.
          </div>
        )}
        {sampleCount === 0 ? (
          <p className="text-sm" style={{ color: "var(--muted)" }}>No samples are linked to this freezer. Link samples by choosing this freezer in the sample&apos;s storage location.</p>
        ) : (
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">Sample</th><th className="th text-left">Type</th><th className="th text-left">Study ID</th><th className="th text-left">Visit</th><th className="th text-left">Status</th></tr></thead>
            <tbody>{samples.map((sm) => (
              <tr key={sm.id}><td className="td"><Link href={`/lab/samples/${sm.id}`} className="font-mono text-xs hover:underline" style={{ color: "var(--brand)" }}>{sm.sampleCode}</Link></td><td className="td">{sm.typeName ?? "—"}</td><td className="td">{sm.studyId ?? "—"}</td><td className="td">{sm.visitLabel ?? "—"}</td><td className="td"><StatusBadge status={sm.status} /></td></tr>
            ))}</tbody>
          </table>{sampleCount > samples.length && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Showing {samples.length} of {sampleCount}.</p>}</div>
        )}
      </div>

      {/* Record reading */}
      <div className="card p-4 mb-5">
        <SectionTitle>Record temperature</SectionTitle>
        <form action={recordTempAction} className="grid sm:grid-cols-5 gap-3 items-end">
          <input type="hidden" name="freezerId" value={f.id} />
          <Field label="Temperature (°C)"><input type="number" step="any" name="temperature" required className="input" /></Field>
          <Field label="Daily min (°C)"><input type="number" step="any" name="minReading" className="input" placeholder="optional" /></Field>
          <Field label="Daily max (°C)"><input type="number" step="any" name="maxReading" className="input" placeholder="optional" /></Field>
          <Field label="Date / time"><input type="datetime-local" name="readingAt" defaultValue={now} className="input" /></Field>
          <div><button className="btn btn-sm btn-primary" type="submit">Log reading</button></div>
          <div className="sm:col-span-5"><Field label="Note"><input name="note" className="input" placeholder="optional" /></Field></div>
        </form>
        {logs.length > 0 && (
          <div className="overflow-x-auto mt-4"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">When</th><th className="th text-right">Temp</th><th className="th text-right">Min</th><th className="th text-right">Max</th><th className="th text-left">Status</th><th className="th text-left">By</th><th className="th text-left">Note</th></tr></thead>
            <tbody>{logs.slice(0, 20).map((r) => (
              <tr key={r.id}><td className="td whitespace-nowrap">{fmtDateTime(r.readingAt)}</td><td className="td text-right tabular-nums" style={{ color: r.inRange ? "inherit" : "var(--danger)" }}>{r.temperature}</td><td className="td text-right tabular-nums">{r.minReading ?? "—"}</td><td className="td text-right tabular-nums">{r.maxReading ?? "—"}</td><td className="td">{r.inRange ? <Badge tone="ok">in range</Badge> : <Badge tone="danger">out</Badge>}</td><td className="td">{r.recordedByName ?? "—"}</td><td className="td">{r.note ?? ""}</td></tr>
            ))}</tbody>
          </table>{logs.length > 20 && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Showing the latest 20 of {logs.length} readings.</p>}</div>
        )}
      </div>

      {/* Incidents */}
      <div className="card p-4">
        <SectionTitle>Incident log</SectionTitle>
        {incidents.length === 0 ? <Empty title="No incidents" hint="Log power outages, alarms, excursions or failures as they arise." /> : (
          <div className="overflow-x-auto mb-3"><table className="w-full text-sm">
            <thead><tr><th className="th text-left">When</th><th className="th text-left">Type</th><th className="th text-left">Severity</th><th className="th text-left">Description</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>{incidents.map((i) => (
              <tr key={i.id}>
                <td className="td whitespace-nowrap">{fmtDateTime(i.incidentAt)}</td>
                <td className="td">{label(i.kind)}</td>
                <td className="td"><Badge tone={sevTone(i.severity)}>{i.severity}</Badge></td>
                <td className="td">{i.description ?? ""}{i.actionTaken ? <div className="text-xs" style={{ color: "var(--muted)" }}>Action: {i.actionTaken}</div> : null}</td>
                <td className="td">{i.resolved ? <span className="text-xs" style={{ color: "var(--muted)" }}>resolved {i.resolvedAt ? fmtDateTime(i.resolvedAt) : ""}</span> : <Badge tone="warn">open</Badge>}</td>
                <td className="td text-right whitespace-nowrap">
                  <form action={resolveFreezerIncidentAction} className="inline"><input type="hidden" name="freezerId" value={f.id} /><input type="hidden" name="incidentId" value={i.id} />{i.resolved && <input type="hidden" name="reopen" value="1" />}<button className="text-xs hover:underline mr-2" type="submit" style={{ color: "var(--brand)" }}>{i.resolved ? "reopen" : "resolve"}</button></form>
                  <form action={deleteFreezerIncidentAction} className="inline"><input type="hidden" name="freezerId" value={f.id} /><input type="hidden" name="incidentId" value={i.id} /><ConfirmSubmit message="Remove this incident?"><button className="text-xs hover:underline" type="submit" style={{ color: "var(--danger)" }}>remove</button></ConfirmSubmit></form>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
        <form action={addFreezerIncidentAction} className="grid sm:grid-cols-4 gap-3 items-end border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <input type="hidden" name="freezerId" value={f.id} />
          <Field label="Type"><select name="kind" defaultValue="power_outage" className="select">{INC_KINDS.map((k) => <option key={k} value={k}>{label(k)}</option>)}</select></Field>
          <Field label="Severity"><select name="severity" defaultValue="warning" className="select">{SEVERITIES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
          <Field label="Date / time"><input type="datetime-local" name="incidentAt" defaultValue={now} className="input" /></Field>
          <div><button className="btn btn-sm btn-primary" type="submit">Log incident</button></div>
          <div className="sm:col-span-2"><Field label="Description"><input name="description" className="input" placeholder="What happened" /></Field></div>
          <div className="sm:col-span-2"><Field label="Action taken"><input name="actionTaken" className="input" placeholder="e.g. moved samples to FZR-02" /></Field></div>
        </form>
      </div>

      {/* Settings */}
      {isAdmin && (
        <div className="card p-4 mt-5">
          <SectionTitle>Freezer settings</SectionTitle>
          <form action={updateFreezerAction} className="grid sm:grid-cols-3 gap-3">
            <input type="hidden" name="freezerId" value={f.id} />
            <Field label="Name / tag"><input name="name" required defaultValue={f.name} className="input" /></Field>
            <Field label="Location"><input name="location" defaultValue={f.location ?? ""} className="input" /></Field>
            <Field label="Type"><select name="kind" defaultValue={f.kind} className="select">{KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
            <Field label="Set point (°C)"><input type="number" step="any" name="setPoint" defaultValue={f.setPoint ?? ""} className="input" /></Field>
            <Field label="Min acceptable (°C)"><input type="number" step="any" name="minTemp" defaultValue={f.minTemp ?? ""} className="input" /></Field>
            <Field label="Max acceptable (°C)"><input type="number" step="any" name="maxTemp" defaultValue={f.maxTemp ?? ""} className="input" /></Field>
            <Field label="Status"><select name="status" defaultValue={f.status} className="select">{STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
            <div className="sm:col-span-2"><Field label="Notes"><input name="notes" defaultValue={f.notes ?? ""} className="input" /></Field></div>
            <div><button className="btn btn-sm btn-primary" type="submit">Save</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
