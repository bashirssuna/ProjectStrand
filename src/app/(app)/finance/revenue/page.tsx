import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Stat, Empty, Badge } from "@/components/ui";
import { money, fmtDate, pct } from "@/lib/format";

// A muted, distinct palette for the pie slices (bronze/gold family + complements).
const PALETTE = ["#9a6a2f", "#c79a4b", "#5b8c7b", "#7b6ca8", "#b56b6b", "#6b8cb5", "#8ca86b", "#a8856b", "#6ba8a0", "#a86b95", "#7d8a99", "#caa46a"];

// Build an SVG arc path for a pie slice (angles measured from the top, clockwise).
function slicePath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const p = (a: number) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const [x0, y0] = p(a0);
  const [x1, y1] = p(a1);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
}

export default async function InstitutionalRevenuePage() {
  const { orgId, orgName } = await requireFinanceOrg();
  const ccy = (await one<{ ccy: string }>(`SELECT COALESCE(display_currency, base_currency, 'UGX') AS ccy FROM organization WHERE id=$1`, [orgId]))?.ccy ?? "UGX";

  // Indirect-cost recovery per project = what each project has spent on its
  // indirect-cost ("overhead") budget lines. That spend is the overhead the
  // institution recovers from hosting the grant.
  const idcRows = await q<{ id: string; code: string; title: string; idc: number }>(
    `SELECT p.id, p.code, p.title, COALESCE(SUM(e.amount),0)::float AS idc
     FROM project p
     JOIN expenditure e ON e.project_id = p.id
     JOIN budget_line bl ON bl.id = e.budget_line_id
     JOIN budget_category bc ON bc.id = bl.category_id
     WHERE p.org_id = $1 AND bc.cost_type = 'indirect'
     GROUP BY p.id, p.code, p.title
     HAVING COALESCE(SUM(e.amount),0) > 0
     ORDER BY idc DESC`, [orgId]
  );
  // Other institutional income = money received that is not tied to a specific grant
  // (service income, donations, interest…), recorded as non-project receipts.
  const otherIncome = (await one<{ t: number }>(`SELECT COALESCE(SUM(amount),0)::float t FROM receipt WHERE org_id=$1 AND project_id IS NULL`, [orgId]))?.t ?? 0;

  const idcTotal = idcRows.reduce((s, r) => s + r.idc, 0);
  const totalRevenue = idcTotal + otherIncome;

  // What the pool funds: institution-level (non-project) payments and assets — rent,
  // internet, office chairs, etc. (Expenditure is always project-scoped, so shared
  // spending lives in non-project vouchers and non-project assets.)
  const voucherUse = (await one<{ t: number; c: number }>(`SELECT COALESCE(SUM(amount),0)::float t, COUNT(*)::int c FROM payment_voucher WHERE org_id=$1 AND project_id IS NULL`, [orgId])) ?? { t: 0, c: 0 };
  const assetUse = (await one<{ t: number; c: number }>(`SELECT COALESCE(SUM(cost),0)::float t, COUNT(*)::int c FROM fixed_asset WHERE org_id=$1 AND project_id IS NULL`, [orgId])) ?? { t: 0, c: 0 };
  const totalUses = (voucherUse.t ?? 0) + (assetUse.t ?? 0);
  const net = totalRevenue - totalUses;

  const recentVouchers = await q<{ number: string; payee: string; purpose: string | null; amount: number }>(
    `SELECT number, payee, purpose, amount::float FROM payment_voucher WHERE org_id=$1 AND project_id IS NULL ORDER BY created_at DESC LIMIT 6`, [orgId]
  );
  const recentAssets = await q<{ name: string; category: string | null; cost: number; currency: string; acquiredOn: string }>(
    `SELECT name, category, cost::float, currency, acquired_on AS "acquiredOn" FROM fixed_asset WHERE org_id=$1 AND project_id IS NULL ORDER BY acquired_on DESC LIMIT 6`, [orgId]
  );

  // Pie slices: one per contributing project, plus an "Other income" slice.
  const slices = [
    ...idcRows.map((r, i) => ({ label: r.code, full: r.title, value: r.idc, color: PALETTE[i % PALETTE.length] })),
    ...(otherIncome > 0 ? [{ label: "Other", full: "Other income (non-project)", value: otherIncome, color: "#9aa0a6" }] : []),
  ];
  const size = 240, cx = size / 2, cy = size / 2, r = size / 2 - 4;
  let acc = 0;
  const arcs = slices.map((s) => {
    const a0 = totalRevenue > 0 ? (acc / totalRevenue) * 2 * Math.PI : 0;
    acc += s.value;
    const a1 = totalRevenue > 0 ? (acc / totalRevenue) * 2 * Math.PI : 0;
    // A single full slice can't draw a 2π arc in one path; nudge it closed.
    const a1adj = slices.length === 1 ? a1 - 0.0001 : a1;
    return { ...s, d: slicePath(cx, cy, r, a0, a1adj), share: totalRevenue > 0 ? s.value / totalRevenue : 0 };
  });

  return (
    <div>
      <PageHeader title="Institutional revenue" subtitle={`Indirect-cost recovery and other income for ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-7">
        <Stat label="Total revenue" value={money(totalRevenue, ccy)} sub="recovery + other income" />
        <Stat label="Indirect-cost recovery" value={money(idcTotal, ccy)} sub={`${idcRows.length} project${idcRows.length === 1 ? "" : "s"}`} />
        <Stat label="Applied to shared costs" value={money(totalUses, ccy)} sub="rent, internet, assets…" tone={totalUses ? "warn" : undefined} />
        <Stat label="Net available" value={money(net, ccy)} tone={net < 0 ? "danger" : "ok"} />
      </div>

      <SectionTitle>Revenue by project</SectionTitle>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        Each project contributes overhead as it spends on its indirect-cost budget lines. Below is each project&apos;s recovered overhead and its share of the institution&apos;s revenue pool.
      </p>

      {totalRevenue <= 0 ? (
        <Empty title="No institutional revenue yet" hint="Overhead recovery appears here once projects record spending on their indirect-cost budget lines, or once non-project income is received." />
      ) : (
        <div className="card p-4 mb-7">
          <div className="flex flex-col lg:flex-row gap-6 items-center lg:items-start">
            <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ flexShrink: 0 }} role="img" aria-label="Revenue contribution by project">
              {arcs.map((a, i) => <path key={i} d={a.d} fill={a.color} stroke="var(--surface)" strokeWidth={1.5} />)}
              <circle cx={cx} cy={cy} r={r * 0.55} fill="var(--surface)" />
              <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontSize: 11, fill: "var(--muted)" }}>Total</text>
              <text x={cx} y={cy + 13} textAnchor="middle" style={{ fontSize: 13, fontWeight: 600, fill: "var(--fg)" }}>{money(totalRevenue, ccy)}</text>
            </svg>
            <div className="w-full">
              <table className="w-full text-sm">
                <thead><tr><th className="th text-left">Source</th><th className="th text-right">Amount</th><th className="th text-right">Share</th></tr></thead>
                <tbody>
                  {arcs.map((a, i) => (
                    <tr key={i}>
                      <td className="td">
                        <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: a.color, marginRight: 8 }} />
                        <span className="font-medium">{a.label}</span>
                        <span style={{ color: "var(--muted)" }}> · {a.full}</span>
                      </td>
                      <td className="td text-right tabular-nums">{money(a.value, ccy)}</td>
                      <td className="td text-right tabular-nums">{pct(a.share * 100)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "2px solid var(--border)" }}>
                    <td className="td font-semibold">Total revenue</td>
                    <td className="td text-right font-semibold tabular-nums">{money(totalRevenue, ccy)}</td>
                    <td className="td text-right font-semibold tabular-nums">100%</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      <SectionTitle>What the revenue funds</SectionTitle>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>
        Recovered overhead pays for shared institutional costs — those not charged to any one grant. These are non-project payments and assets.
      </p>
      <div className="grid md:grid-cols-2 gap-4 mb-4">
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2"><div className="font-medium">Shared services & payments</div><Badge tone="muted">{voucherUse.c}</Badge></div>
          <div className="text-lg font-semibold tabular-nums mb-2">{money(voucherUse.t ?? 0, ccy)}</div>
          {recentVouchers.length === 0 ? <p className="text-xs" style={{ color: "var(--muted)" }}>No non-project payment vouchers yet. Raise a voucher with no project to pay for rent, internet, etc.</p> : (
            <table className="w-full text-xs"><tbody>
              {recentVouchers.map((v, i) => (
                <tr key={i}><td className="td">{v.payee}{v.purpose ? <span style={{ color: "var(--muted)" }}> · {v.purpose}</span> : ""}</td><td className="td text-right tabular-nums">{money(v.amount, ccy)}</td></tr>
              ))}
            </tbody></table>
          )}
        </div>
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2"><div className="font-medium">Institutional assets</div><Badge tone="muted">{assetUse.c}</Badge></div>
          <div className="text-lg font-semibold tabular-nums mb-2">{money(assetUse.t ?? 0, ccy)}</div>
          {recentAssets.length === 0 ? <p className="text-xs" style={{ color: "var(--muted)" }}>No non-project assets yet. Register an asset with no project (e.g. office chairs) to track it here.</p> : (
            <table className="w-full text-xs"><tbody>
              {recentAssets.map((a, i) => (
                <tr key={i}><td className="td">{a.name}{a.category ? <span style={{ color: "var(--muted)" }}> · {a.category}</span> : ""}<span style={{ color: "var(--muted)" }}> · {fmtDate(a.acquiredOn)}</span></td><td className="td text-right tabular-nums">{money(a.cost, a.currency)}</td></tr>
              ))}
            </tbody></table>
          )}
        </div>
      </div>

      <div className="card p-4 text-xs" style={{ color: "var(--muted)" }}>
        Indirect-cost recovery is computed from each project&apos;s spending on its indirect-cost budget lines; it is a management view of overhead earned, not a separate ledger posting. Figures are shown in {ccy} and assume a common currency across projects.
      </div>
    </div>
  );
}
