import { STATUS_TONE } from "@/lib/enums";

export type GanttRow = {
  id: string; code: string | null; title: string; type: string;
  status: string; progress: number;
  startDate: string | null; endDate: string | null;
};

const TONE_VAR: Record<string, string> = {
  ok: "var(--ok)", warn: "var(--warn)", danger: "var(--danger)", info: "var(--info)", muted: "var(--muted)",
};

function monthsBetween(start: Date, end: Date): Date[] {
  const out: Date[] = [];
  const d = new Date(start.getFullYear(), start.getMonth(), 1);
  while (d <= end) { out.push(new Date(d)); d.setMonth(d.getMonth() + 1); }
  return out;
}

export function Gantt({ rows }: { rows: GanttRow[] }) {
  const dated = rows.filter((r) => r.startDate && r.endDate);
  if (dated.length === 0) {
    return <p className="text-sm" style={{ color: "var(--muted)" }}>Add start and end dates to activities to see the timeline.</p>;
  }

  const starts = dated.map((r) => new Date(r.startDate!).getTime());
  const ends = dated.map((r) => new Date(r.endDate!).getTime());
  const min = new Date(Math.min(...starts));
  const max = new Date(Math.max(...ends));
  const minM = new Date(min.getFullYear(), min.getMonth(), 1);
  const maxM = new Date(max.getFullYear(), max.getMonth() + 1, 1);
  const span = maxM.getTime() - minM.getTime() || 1;

  const labelW = 240;
  const chartW = 720;
  const rowH = 30;
  const headH = 28;
  const W = labelW + chartW;
  const H = headH + rows.length * rowH + 8;
  const months = monthsBetween(minM, max);
  const x = (t: number) => labelW + ((t - minM.getTime()) / span) * chartW;
  const todayX = x(Date.now());
  const showToday = Date.now() >= minM.getTime() && Date.now() <= maxM.getTime();

  return (
    <div className="card p-3 overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 680 }} fontFamily="inherit">
        {/* month gridlines + labels */}
        {months.map((m, i) => {
          const mx = x(m.getTime());
          return (
            <g key={i}>
              <line x1={mx} y1={headH} x2={mx} y2={H} stroke="var(--border)" strokeWidth={1} />
              <text x={mx + 3} y={18} fontSize={10} fill="var(--muted)">
                {m.toLocaleDateString("en-US", { month: "short", year: m.getMonth() === 0 || i === 0 ? "2-digit" : undefined })}
              </text>
            </g>
          );
        })}
        <line x1={labelW} y1={headH} x2={labelW} y2={H} stroke="var(--border)" strokeWidth={1.5} />
        {showToday && (
          <line x1={todayX} y1={headH} x2={todayX} y2={H} stroke="var(--brand)" strokeWidth={1.5} strokeDasharray="3 3" />
        )}

        {rows.map((r, i) => {
          const y = headH + i * rowH;
          const tone = TONE_VAR[STATUS_TONE[r.status] ?? "muted"] ?? "var(--muted)";
          const hasDates = r.startDate && r.endDate;
          const bx = hasDates ? x(new Date(r.startDate!).getTime()) : labelW;
          const ex = hasDates ? x(new Date(r.endDate!).getTime()) : labelW;
          const bw = Math.max(hasDates ? ex - bx : 0, 3);
          const isMilestone = r.type === "milestone";
          return (
            <g key={r.id}>
              {i % 2 === 1 && <rect x={0} y={y} width={W} height={rowH} fill="var(--surface)" opacity={0.5} />}
              <text x={10} y={y + rowH / 2 + 4} fontSize={11} fill="var(--fg)">
                <tspan fill="var(--muted)">{r.code ? r.code + "  " : ""}</tspan>
                {r.title.length > 32 ? r.title.slice(0, 31) + "…" : r.title}
              </text>
              {hasDates && !isMilestone && (
                <>
                  <rect x={bx} y={y + 7} width={bw} height={rowH - 16} rx={3} fill={tone} opacity={0.25} />
                  <rect x={bx} y={y + 7} width={(bw * Math.min(100, r.progress)) / 100} height={rowH - 16} rx={3} fill={tone} />
                </>
              )}
              {hasDates && isMilestone && (
                <path d={`M ${bx} ${y + rowH / 2 - 6} l 6 6 l -6 6 l -6 -6 z`} fill="var(--brand)" />
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
