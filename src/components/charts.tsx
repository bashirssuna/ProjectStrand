// Dependency-free SVG charts (server-renderable).
export function Donut({ segments, size = 132, thickness = 20, centerLabel, centerSub }: {
  segments: { label: string; value: number; color: string }[];
  size?: number; thickness?: number; centerLabel?: string; centerSub?: string;
}) {
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  let cum = 0;
  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" style={{ flexShrink: 0 }}>
        {total === 0 ? (
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--surface)" strokeWidth={thickness} />
        ) : shown.map((s, i) => {
          const len = (s.value / total) * circ;
          const el = (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color} strokeWidth={thickness}
              strokeDasharray={`${len} ${circ - len}`} strokeDashoffset={-cum} transform={`rotate(-90 ${cx} ${cy})`}>
              <title>{s.label}: {s.value}</title>
            </circle>
          );
          cum += len;
          return el;
        })}
        {centerLabel && <text x={cx} y={cy - 1} textAnchor="middle" style={{ fontSize: 18, fontWeight: 700, fill: "var(--fg)" }}>{centerLabel}</text>}
        {centerSub && <text x={cx} y={cy + 15} textAnchor="middle" style={{ fontSize: 9, fill: "var(--muted)" }}>{centerSub}</text>}
      </svg>
      <div className="space-y-1 min-w-0 flex-1">
        {shown.length === 0 ? <div className="text-xs" style={{ color: "var(--muted)" }}>No data yet</div> : shown.map((s, i) => (
          <div key={i} className="flex items-center gap-1.5 text-xs">
            <span style={{ width: 9, height: 9, borderRadius: 2, background: s.color, display: "inline-block", flexShrink: 0 }} />
            <span className="truncate">{s.label}</span>
            <span className="tabular-nums ml-auto pl-2" style={{ color: "var(--muted)" }}>{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function HBar({ label, value, max, money: moneyText, tone = "var(--brand)" }: {
  label: string; value: number; max: number; money?: string; tone?: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between gap-3 text-xs mb-1">
        <span className="truncate">{label}</span>
        <span className="tabular-nums whitespace-nowrap" style={{ color: "var(--muted)" }}>{moneyText ?? `${Math.round(pct)}%`}</span>
      </div>
      <div style={{ height: 8, borderRadius: 4, background: "var(--surface)", border: "1px solid var(--border)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: pct > 100 ? "var(--danger)" : tone }} />
      </div>
    </div>
  );
}

export function ColumnChart({ data, height = 140, valueFmt }: {
  data: { label: string; value: number }[]; height?: number; valueFmt?: (v: number) => string;
}) {
  if (data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.value), 1);
  const bw = 100 / data.length;
  return (
    <div>
      <svg viewBox={`0 0 100 ${height / 2.2}`} preserveAspectRatio="none" style={{ width: "100%", height }} role="img">
        {data.map((d, i) => {
          const h = (d.value / max) * (height / 2.2 - 12);
          const w = Math.min(bw * 0.7, 12);
          return (
            <rect key={i} x={i * bw + (bw - w) / 2} y={height / 2.2 - h} width={w} height={h}
              rx={1} fill="var(--brand)">
              <title>{d.label}: {valueFmt ? valueFmt(d.value) : d.value}</title>
            </rect>
          );
        })}
      </svg>
      <div className="grid text-center" style={{ gridTemplateColumns: `repeat(${data.length}, 1fr)` }}>
        {data.map((d, i) => (
          <div key={i} className="text-[10px] truncate px-0.5" style={{ color: "var(--muted)" }}>{d.label}</div>
        ))}
      </div>
    </div>
  );
}
