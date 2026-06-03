import { cn } from "@/lib/cn";
import { STATUS_TONE, label } from "@/lib/enums";
import { pct } from "@/lib/format";

type Tone = "ok" | "warn" | "danger" | "info" | "muted" | "brand";

const TONE_STYLE: Record<Tone, { color: string; bg: string; dot: string }> = {
  ok: { color: "var(--ok)", bg: "color-mix(in srgb, var(--ok) 12%, transparent)", dot: "var(--ok)" },
  warn: { color: "var(--warn)", bg: "color-mix(in srgb, var(--warn) 14%, transparent)", dot: "var(--warn)" },
  danger: { color: "var(--danger)", bg: "color-mix(in srgb, var(--danger) 12%, transparent)", dot: "var(--danger)" },
  info: { color: "var(--info)", bg: "color-mix(in srgb, var(--info) 12%, transparent)", dot: "var(--info)" },
  brand: { color: "var(--brand)", bg: "color-mix(in srgb, var(--brand) 12%, transparent)", dot: "var(--brand)" },
  muted: { color: "var(--muted)", bg: "color-mix(in srgb, var(--muted) 12%, transparent)", dot: "var(--muted)" },
};

export function Badge({ children, tone = "muted", dot = false }: { children: React.ReactNode; tone?: Tone; dot?: boolean }) {
  const s = TONE_STYLE[tone];
  return (
    <span className="badge" style={{ color: s.color, background: s.bg, borderColor: "transparent" }}>
      {dot && <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: s.dot }} />}
      {children}
    </span>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const tone = (STATUS_TONE[status] ?? "muted") as Tone;
  return <Badge tone={tone} dot>{label(status)}</Badge>;
}

export function ProgressBar({ value, tone = "brand", showLabel = false }: { value: number; tone?: Tone; showLabel?: boolean }) {
  const s = TONE_STYLE[tone];
  const v = Math.min(100, Math.max(0, value));
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 flex-1 rounded-full overflow-hidden" style={{ background: "var(--border)" }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${v}%`, background: s.color }} />
      </div>
      {showLabel && <span className="text-xs tabular-nums" style={{ color: "var(--muted)" }}>{pct(v)}</span>}
    </div>
  );
}

export function Stat({ label: l, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: Tone }) {
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--muted)" }}>{l}</div>
      <div className="kpi mt-1" style={tone ? { color: TONE_STYLE[tone].color } : undefined}>{value}</div>
      {sub && <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>{sub}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 mb-6">
      <div>
        <h1 className="font-display text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="font-display text-lg font-semibold">{children}</h2>
      {action}
    </div>
  );
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card p-8 text-center">
      <p className="font-display text-base">{title}</p>
      {hint && <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>{hint}</p>}
    </div>
  );
}

export function Field({ label: l, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{l}</span>
      {children}
    </label>
  );
}

export function severityTone(sev: string): Tone {
  return sev === "critical" ? "danger" : sev === "warning" ? "warn" : "info";
}

// Color-codes a progress value (optionally overridden by a blocked status).
export function progressTone(progress: number, status?: string): Tone {
  if (status === "blocked") return "danger";
  if (progress >= 100) return "ok";
  if (progress >= 67) return "brand";
  if (progress >= 34) return "info";
  if (progress >= 1) return "warn";
  return "muted";
}

export { cn };
