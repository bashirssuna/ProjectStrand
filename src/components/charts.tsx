// Dependency-free SVG charts (server-renderable).
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
