import Link from "next/link";
import { notFound } from "next/navigation";
import { requireFinanceOrg } from "../../_guard";
import { getForecast, listLines, buildProjection, FORECAST_CATEGORIES } from "@/server/services/cashflow";
import { PageHeader, SectionTitle, Field, Stat, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { addForecastLineAction, deleteForecastLineAction, updateForecastAction, archiveForecastAction, deleteForecastAction } from "@/app/actions";

const srcTone = (s: string) => (s === "funding" ? "info" : s === "investment" ? "ok" : "muted");

export default async function ForecastDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const { id } = await params;
  const sp = await searchParams;
  const f = await getForecast(orgId, id);
  if (!f) notFound();
  const [proj, lines] = await Promise.all([buildProjection(orgId, f), listLines(orgId, id)]);
  const ccy = f.currency;
  const archived = f.status === "archived";
  const today = new Date().toISOString().slice(0, 10);

  // trajectory chart geometry
  const vals = proj.periods.map((p) => p.closing);
  const hi = Math.max(0, proj.openingBalance, ...vals);
  const lo = Math.min(0, proj.openingBalance, ...vals);
  const range = hi - lo || 1;
  const colW = 44, W = Math.max(proj.periods.length * colW, 220);
  const yOf = (v: number) => 100 - ((v - lo) / range) * 90; // 10..100
  const y0 = yOf(0);

  return (
    <div className="max-w-5xl">
      <PageHeader title={f.name} subtitle={`Cash forecast · ${orgName}`} actions={<Link href="/finance/cash-forecast" className="btn btn-sm">← Forecasts</Link>} />
      {sp.err === "amount" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter a valid amount.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        {archived ? <Badge tone="muted">Archived</Badge> : <Badge tone="ok">Active</Badge>}
        <span className="text-sm" style={{ color: "var(--muted)" }}>{fmtDate(f.startDate)} · {f.months} months · {ccy}</span>
        {proj.anyShortfall && <Badge tone="danger">Cash shortfall projected</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <form action={archiveForecastAction}><input type="hidden" name="forecastId" value={f.id} /><input type="hidden" name="reopen" value={archived ? "1" : "0"} /><button className="btn btn-sm" type="submit">{archived ? "Unarchive" : "Archive"}</button></form>
          <form action={deleteForecastAction}><input type="hidden" name="forecastId" value={f.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-5">
        <Stat label="Opening" value={money(f.openingBalance, ccy)} />
        <Stat label="Total inflows" value={money(proj.totalInflow, ccy)} tone="ok" />
        <Stat label="Total outflows" value={money(proj.totalOutflow, ccy)} tone="warn" />
        <Stat label="Projected end" value={money(proj.endBalance, ccy)} tone={proj.endBalance < 0 ? "danger" : undefined} />
        <Stat label="Lowest point" value={money(proj.lowestClosing, ccy)} tone={proj.lowestClosing < 0 ? "danger" : undefined} />
      </div>

      {/* Trajectory */}
      <div className="card p-4 mb-5">
        <div className="text-sm font-medium mb-2">Closing balance trajectory</div>
        <svg viewBox={`0 0 ${W} 118`} width="100%" height="150" preserveAspectRatio="xMidYMid meet" role="img">
          <line x1="0" y1={y0} x2={W} y2={y0} stroke="var(--border)" strokeWidth="1" strokeDasharray="3 3" />
          {proj.periods.map((p, i) => {
            const yTop = yOf(p.closing);
            const top = Math.min(yTop, y0), h = Math.max(Math.abs(yTop - y0), 0.5);
            return (
              <g key={p.key}>
                <rect x={i * colW + 7} y={top} width={colW - 14} height={h} rx="2" fill={p.closing < 0 ? "var(--danger)" : "var(--ok)"} opacity="0.85" />
                <text x={i * colW + colW / 2} y="113" textAnchor="middle" fontSize="7" fill="var(--muted)">{p.label.split(" ")[0]}</text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Projection table */}
      <SectionTitle>Monthly projection</SectionTitle>
      <div className="mt-2 mb-5 card overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr><th className="th text-left">Month</th><th className="th text-right">Opening</th><th className="th text-right">Inflows</th><th className="th text-right">Outflows</th><th className="th text-right">Net</th><th className="th text-right">Closing</th></tr></thead>
          <tbody>
            {proj.periods.map((p) => (
              <tr key={p.key} style={p.shortfall ? { background: "color-mix(in srgb, var(--danger) 10%, transparent)" } : undefined}>
                <td className="td font-medium">{p.label}</td>
                <td className="td text-right whitespace-nowrap">{money(p.opening, ccy)}</td>
                <td className="td text-right whitespace-nowrap" style={{ color: p.inflow ? "var(--ok)" : "var(--muted)" }}>{p.inflow ? money(p.inflow, ccy) : "—"}</td>
                <td className="td text-right whitespace-nowrap" style={{ color: p.outflow ? "var(--danger)" : "var(--muted)" }}>{p.outflow ? money(p.outflow, ccy) : "—"}</td>
                <td className="td text-right whitespace-nowrap">{p.net >= 0 ? "+" : "−"}{money(Math.abs(p.net), ccy)}</td>
                <td className="td text-right whitespace-nowrap font-medium" style={{ color: p.closing < 0 ? "var(--danger)" : undefined }}>{money(p.closing, ccy)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Per-period breakdown */}
      <details className="card p-4 mb-5">
        <summary className="text-sm font-medium cursor-pointer">Breakdown by month</summary>
        <div className="mt-3 space-y-3">
          {proj.periods.filter((p) => p.items.length > 0).map((p) => (
            <div key={p.key}>
              <div className="text-xs font-semibold uppercase tracking-wide mb-1" style={{ color: "var(--muted)" }}>{p.label}</div>
              <div className="space-y-1">
                {p.items.map((it, idx) => (
                  <div key={idx} className="flex items-center gap-2 text-sm">
                    <Badge tone={srcTone(it.source)}>{label(it.source)}</Badge>
                    <span>{it.label}</span>
                    <span className="ml-auto whitespace-nowrap" style={{ color: it.direction === "inflow" ? "var(--ok)" : "var(--danger)" }}>{it.direction === "inflow" ? "+" : "−"}{money(it.amount, ccy)}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {proj.periods.every((p) => p.items.length === 0) && <p className="text-sm" style={{ color: "var(--muted)" }}>No flows fall within the horizon yet.</p>}
        </div>
      </details>

      {/* Manual lines */}
      <SectionTitle>Planned cash flows</SectionTitle>
      <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Funding tranches and investment maturities are pulled automatically{f.includeFunding || f.includeInvestments ? "" : " (disabled in settings)"}; add other expected receipts and payments here.</p>
      <div className="mt-1 mb-4">
        {lines.length === 0 ? <Empty title="No manual lines" hint="Add expected payments and receipts below." /> : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Date</th><th className="th text-left">Direction</th><th className="th text-left">Description</th><th className="th text-right">Amount</th><th className="th text-left">Recurs</th><th className="th" /></tr></thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id}>
                    <td className="td whitespace-nowrap">{fmtDate(l.lineDate)}</td>
                    <td className="td"><Badge tone={l.direction === "inflow" ? "ok" : "warn"}>{label(l.direction)}</Badge></td>
                    <td className="td">{l.description || l.category || "—"}{l.category && l.description ? <span className="text-xs" style={{ color: "var(--muted)" }}> · {l.category}</span> : null}</td>
                    <td className="td text-right whitespace-nowrap">{money(l.amount, ccy)}</td>
                    <td className="td">{l.recurring === "monthly" ? `Monthly${l.recurUntil ? ` to ${fmtDate(l.recurUntil)}` : ""}` : "—"}</td>
                    <td className="td text-right">{!archived && <form action={deleteForecastLineAction}><input type="hidden" name="lineId" value={l.id} /><input type="hidden" name="forecastId" value={f.id} /><button className="btn btn-sm" type="submit" title="Remove">✕</button></form>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!archived && (
        <div className="grid md:grid-cols-2 gap-5">
          <div className="card p-4">
            <SectionTitle>Add planned flow</SectionTitle>
            <form action={addForecastLineAction} className="grid sm:grid-cols-2 gap-3 mt-2">
              <input type="hidden" name="forecastId" value={f.id} />
              <Field label="Direction"><select name="direction" className="select select-sm"><option value="outflow">Outflow (payment)</option><option value="inflow">Inflow (receipt)</option></select></Field>
              <Field label="Amount *"><input name="amount" type="number" step="0.01" min="0" required className="input input-sm" /></Field>
              <Field label="Date"><input name="lineDate" type="date" defaultValue={today} className="input input-sm" /></Field>
              <Field label="Category"><select name="category" className="select select-sm"><option value="">—</option>{FORECAST_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
              <div className="sm:col-span-2"><Field label="Description"><input name="description" className="input input-sm" /></Field></div>
              <Field label="Recurring"><select name="recurring" className="select select-sm"><option value="none">One-off</option><option value="monthly">Monthly</option></select></Field>
              <Field label="Recur until (if monthly)"><input name="recurUntil" type="date" className="input input-sm" /></Field>
              <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Add line</button></div>
            </form>
          </div>

          <details className="card p-4 self-start">
            <summary className="text-sm font-medium cursor-pointer">Forecast settings</summary>
            <form action={updateForecastAction} className="grid sm:grid-cols-2 gap-3 mt-3">
              <input type="hidden" name="forecastId" value={f.id} />
              <Field label="Opening balance"><input name="openingBalance" type="number" step="0.01" defaultValue={f.openingBalance} className="input input-sm" /></Field>
              <Field label="Start month"><input name="startDate" type="date" defaultValue={new Date(f.startDate).toISOString().slice(0, 10)} className="input input-sm" /></Field>
              <Field label="Horizon (months)"><input name="months" type="number" min="1" max="36" defaultValue={f.months} className="input input-sm" /></Field>
              <div className="flex flex-col gap-1 justify-end text-sm">
                <label className="flex items-center gap-2"><input type="checkbox" name="includeFunding" defaultChecked={f.includeFunding} /> Funding tranches</label>
                <label className="flex items-center gap-2"><input type="checkbox" name="includeInvestments" defaultChecked={f.includeInvestments} /> Investment maturities</label>
              </div>
              <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Save settings</button></div>
            </form>
          </details>
        </div>
      )}
    </div>
  );
}
