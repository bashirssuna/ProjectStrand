import Link from "next/link";
import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { budgetLineRollups } from "@/server/services/budget";
import { HBar, ColumnChart } from "@/components/charts";
import { money, pct, fmtDate } from "@/lib/format";
import { getFinancialStatements } from "@/server/services/financials";
import { generateReportAction, emailReportAction } from "@/app/actions";
import { SectionTitle, Empty, Badge, Field, StatusBadge } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { blockStaff } from "../_staffblock";

export default async function ReportsPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ r?: string; fin?: string }> }) {
  const { id } = await params;
  await blockStaff(id);
  const { r, fin } = await searchParams;
  const detailed = fin === "detailed";
  const access = await getProjectAccess(id);
  const canManage = access.permissions.has("reports.manage");

  const reports = await q<{ id: string; type: string; title: string; status: string; periodLabel: string | null; ai: boolean; createdAt: string }>(
    `SELECT id, type, title, status, period_label AS "periodLabel", generated_by_ai AS ai, created_at AS "createdAt"
     FROM report WHERE project_id=$1 ORDER BY created_at DESC`, [id]
  );

  const selectedId = r ?? reports[0]?.id;
  const selected = selectedId ? await one<{ id: string; title: string; status: string; ai: boolean }>(
    `SELECT id, title, status, generated_by_ai AS ai FROM report WHERE id=$1 AND project_id=$2`, [selectedId, id]
  ) : null;
  const sections = selected ? await q<{ id: string; title: string; content: string }>(
    `SELECT id, title, content FROM report_section WHERE report_id=$1 ORDER BY "order"`, [selected.id]
  ) : [];

  // ---- financial statements data ----
  const proj = await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [id]);
  const c = proj?.currency ?? "USD";
  const bud = await one<{ id: string }>(`SELECT id FROM budget WHERE project_id=$1 ORDER BY version DESC LIMIT 1`, [id]);
  const lines = bud ? await budgetLineRollups(bud.id) : [];
  const totPlanned = lines.reduce((s, l) => s + l.planned, 0);
  const totActual = lines.reduce((s, l) => s + l.actual, 0);
  const monthly = await q<{ m: string; v: number }>(
    `SELECT to_char(date_trunc('month', date), 'Mon YY') AS m, SUM(amount)::float AS v
     FROM expenditure WHERE project_id=$1
     GROUP BY date_trunc('month', date) ORDER BY date_trunc('month', date)`, [id]
  );
  const avgBurn = monthly.length ? monthly.reduce((s, r) => s + r.v, 0) / monthly.length : 0;
  const runway = avgBurn > 0 ? (totPlanned - totActual) / avgBurn : null;
  const fs = await getFinancialStatements(id);

  return (
    <div className="grid lg:grid-cols-3 gap-6">
      <div className="space-y-5">
        {canManage && (
          <form action={generateReportAction} className="card p-4 space-y-3">
            <SectionTitle>Generate report</SectionTitle>
            <Field label="Type">
              <select name="type" className="select" defaultValue="quarterly">
                {["monthly", "quarterly", "donor", "internal", "financial", "milestone"].map((t) => <option key={t} value={t}>{label(t)}</option>)}
              </select>
            </Field>
            <Field label="Period"><input name="periodLabel" className="input" placeholder="Q2 2025" defaultValue="Current period" /></Field>
            <input type="hidden" name="projectId" value={id} />
            <button className="btn btn-primary w-full" type="submit">Draft from live data</button>
            <p className="text-xs" style={{ color: "var(--muted)" }}>Pulls activities, indicators, budget and flags into an editable draft.</p>
          </form>
        )}

        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b text-sm font-medium" style={{ borderColor: "var(--border)" }}>All reports</div>
          {reports.length === 0 ? (
            <div className="p-4 text-sm" style={{ color: "var(--muted)" }}>No reports yet.</div>
          ) : reports.map((rep) => (
            <Link key={rep.id} href={`/projects/${id}/reports?r=${rep.id}`}
              className="block px-4 py-3 border-b last:border-0 hover:bg-[var(--surface)]"
              style={{ borderColor: "var(--border)", background: rep.id === selectedId ? "var(--surface)" : undefined }}>
              <div className="text-sm font-medium">{rep.title}</div>
              <div className="flex items-center gap-2 mt-1">
                <StatusBadge status={rep.status} />
                {rep.ai && <Badge tone="info">AI draft</Badge>}
                <span className="text-xs" style={{ color: "var(--muted)" }}>{fmtDateTime(rep.createdAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>

      <div className="lg:col-span-2">
        {!selected ? (
          <Empty title="No report selected" hint="Generate a report or pick one from the list." />
        ) : (
          <div className="card p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="font-display text-xl font-semibold">{selected.title}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <StatusBadge status={selected.status} />
                  {selected.ai && <Badge tone="info">AI-generated draft — review before sharing</Badge>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a href={`/api/reports/${selected.id}/docx`} className="btn btn-sm">Download Word</a>
                {canManage && (
                  <form action={emailReportAction}>
                    <input type="hidden" name="projectId" value={id} />
                    <input type="hidden" name="reportId" value={selected.id} />
                    <button className="btn btn-sm" type="submit">Email to team</button>
                  </form>
                )}
              </div>
            </div>
            <div className="space-y-5">
              {sections.map((s) => (
                <div key={s.id}>
                  <h3 className="font-display font-semibold mb-1">{s.title}</h3>
                  <div className="text-sm whitespace-pre-line leading-relaxed" style={{ color: "var(--fg)" }}>{s.content}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ---- Financial statements ---- */}
      <div className="lg:col-span-3 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle>Financial statements</SectionTitle>
          <div className="flex items-center gap-2">
            <div className="flex rounded-md overflow-hidden" style={{ border: "1px solid var(--border)" }}>
              <Link href={`/projects/${id}/reports?fin=summary`} className="btn btn-sm" style={{ borderRadius: 0, background: detailed ? "transparent" : "var(--surface)" }}>Summary</Link>
              <Link href={`/projects/${id}/reports?fin=detailed`} className="btn btn-sm" style={{ borderRadius: 0, background: detailed ? "var(--surface)" : "transparent" }}>Detailed</Link>
            </div>
            <a href={`/print/financials/${id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨 Print all / PDF</a>
          </div>
        </div>

        {/* 1. Budget vs Expenditure (variance) */}
        <div className="card p-4 overflow-x-auto">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium">1. Budget vs Expenditure (variance)</div>
            <a href={`/api/financials/${id}?statement=variance`} className="btn btn-sm">⬇ CSV</a>
          </div>
          {fs.variance.lines.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>No budget lines yet.</p> : detailed ? (
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Line</th><th className="th text-left">Category</th>
                <th className="th text-right">Budget</th><th className="th text-right">Committed</th>
                <th className="th text-right">Actual</th><th className="th text-right">Variance</th><th className="th text-right">% used</th>
              </tr></thead>
              <tbody>
                {fs.variance.lines.map((l) => (
                  <tr key={l.code}>
                    <td className="td"><div className="max-w-[300px] truncate" title={l.description}><span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{l.code}</span> {l.description}</div></td>
                    <td className="td text-xs">{l.category}</td>
                    <td className="td text-right tabular-nums whitespace-nowrap">{money(l.planned, c)}</td>
                    <td className="td text-right tabular-nums whitespace-nowrap">{money(l.committed, c)}</td>
                    <td className="td text-right tabular-nums whitespace-nowrap">{money(l.actual, c)}</td>
                    <td className="td text-right tabular-nums whitespace-nowrap" style={{ color: l.variance < 0 ? "var(--danger)" : "var(--ok)" }}>{money(l.variance, c)}</td>
                    <td className="td text-right tabular-nums">{l.pctUsed.toFixed(0)}%</td>
                  </tr>
                ))}
                <tr>
                  <td className="td font-medium" colSpan={2}>Total</td>
                  <td className="td text-right tabular-nums font-medium">{money(fs.variance.totals.planned, c)}</td>
                  <td className="td text-right tabular-nums font-medium">{money(fs.variance.totals.committed, c)}</td>
                  <td className="td text-right tabular-nums font-medium">{money(fs.variance.totals.actual, c)}</td>
                  <td className="td text-right tabular-nums font-medium" style={{ color: fs.variance.totals.variance < 0 ? "var(--danger)" : "var(--ok)" }}>{money(fs.variance.totals.variance, c)}</td>
                  <td className="td text-right tabular-nums font-medium">{fs.variance.totals.pctUsed.toFixed(0)}%</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Category</th><th className="th text-right">Budget</th><th className="th text-right">Actual</th><th className="th text-right">Variance</th></tr></thead>
              <tbody>
                {fs.variance.byCategory.map((c2) => (
                  <tr key={c2.category}>
                    <td className="td">{c2.category}</td>
                    <td className="td text-right tabular-nums whitespace-nowrap">{money(c2.planned, c)}</td>
                    <td className="td text-right tabular-nums whitespace-nowrap">{money(c2.actual, c)}</td>
                    <td className="td text-right tabular-nums whitespace-nowrap" style={{ color: c2.variance < 0 ? "var(--danger)" : "var(--ok)" }}>{money(c2.variance, c)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="td font-medium">Total</td>
                  <td className="td text-right tabular-nums font-medium">{money(fs.variance.totals.planned, c)}</td>
                  <td className="td text-right tabular-nums font-medium">{money(fs.variance.totals.actual, c)}</td>
                  <td className="td text-right tabular-nums font-medium" style={{ color: fs.variance.totals.variance < 0 ? "var(--danger)" : "var(--ok)" }}>{money(fs.variance.totals.variance, c)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>

        <div className="grid lg:grid-cols-2 gap-5">
          {/* 2. Revenue vs Expenditure */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">2. Revenue vs Expenditure</div>
              <a href={`/api/financials/${id}?statement=revexp`} className="btn btn-sm">⬇ CSV</a>
            </div>
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Basis</th><th className="th text-right">Revenue</th><th className="th text-right">Expenditure</th><th className="th text-right">Surplus</th></tr></thead>
              <tbody>
                <tr><td className="td">Cash</td><td className="td text-right tabular-nums">{money(fs.revVsExp.cash.revenue, c)}</td><td className="td text-right tabular-nums">{money(fs.revVsExp.cash.expenditure, c)}</td><td className="td text-right tabular-nums" style={{ color: fs.revVsExp.cash.surplus < 0 ? "var(--danger)" : "var(--ok)" }}>{money(fs.revVsExp.cash.surplus, c)}</td></tr>
                <tr><td className="td">Accrual</td><td className="td text-right tabular-nums">{money(fs.revVsExp.accrual.revenue, c)}</td><td className="td text-right tabular-nums">{money(fs.revVsExp.accrual.expenditure, c)}</td><td className="td text-right tabular-nums" style={{ color: fs.revVsExp.accrual.surplus < 0 ? "var(--danger)" : "var(--ok)" }}>{money(fs.revVsExp.accrual.surplus, c)}</td></tr>
              </tbody>
            </table>
            {detailed && <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Cash basis recognises revenue and expenditure as funds are actually spent; accrual basis recognises the full award and includes outstanding commitments.</p>}
          </div>

          {/* 3. Balance Sheet */}
          <div className="card p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium">3. Balance Sheet</div>
              <a href={`/api/financials/${id}?statement=balance`} className="btn btn-sm">⬇ CSV</a>
            </div>
            <table className="w-full text-sm">
              <tbody>
                <tr><td className="td">Cash and bank</td><td className="td text-right tabular-nums">{money(fs.balanceSheet.cashAndBank, c)}</td></tr>
                <tr><td className="td">Grant receivable</td><td className="td text-right tabular-nums">{money(fs.balanceSheet.receivables, c)}</td></tr>
                <tr><td className="td font-medium">Total assets</td><td className="td text-right tabular-nums font-medium">{money(fs.balanceSheet.totalAssets, c)}</td></tr>
                <tr><td className="td">Payables (commitments)</td><td className="td text-right tabular-nums">{money(fs.balanceSheet.payables, c)}</td></tr>
                <tr><td className="td font-medium">Total liabilities</td><td className="td text-right tabular-nums font-medium">{money(fs.balanceSheet.totalLiabilities, c)}</td></tr>
                <tr><td className="td font-medium">Fund balance</td><td className="td text-right tabular-nums font-medium">{money(fs.balanceSheet.fundBalance, c)}</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* 4. Cashflow */}
        <div className="card p-4 overflow-x-auto">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium">4. Cashflow Statement</div>
            <a href={`/api/financials/${id}?statement=cashflow`} className="btn btn-sm">⬇ CSV</a>
          </div>
          {fs.cashflow.months.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>No cash movements recorded yet.</p> : (
            <table className="w-full text-sm">
              <thead><tr><th className="th text-left">Month</th><th className="th text-right">Receipts</th><th className="th text-right">Payments</th><th className="th text-right">Net</th></tr></thead>
              <tbody>
                {fs.cashflow.months.map((m) => (
                  <tr key={m.month}><td className="td">{m.month}</td><td className="td text-right tabular-nums">{money(m.receipts, c)}</td><td className="td text-right tabular-nums">{money(m.payments, c)}</td><td className="td text-right tabular-nums" style={{ color: m.net < 0 ? "var(--danger)" : "var(--ok)" }}>{money(m.net, c)}</td></tr>
                ))}
                <tr><td className="td font-medium">Total</td><td className="td text-right tabular-nums font-medium">{money(fs.cashflow.totalReceipts, c)}</td><td className="td text-right tabular-nums font-medium">{money(fs.cashflow.totalPayments, c)}</td><td className="td text-right tabular-nums font-medium">{money(fs.cashflow.netCashflow, c)}</td></tr>
              </tbody>
            </table>
          )}
        </div>

        {/* Burn rate (chart only — not part of the formal statements) */}
        <div className="card p-4">
          <div className="text-sm font-medium mb-2">Burn rate</div>
          {monthly.length === 0 ? <p className="text-sm" style={{ color: "var(--muted)" }}>No expenditure recorded yet.</p> : (
            <>
              <ColumnChart data={monthly.map((row) => ({ label: row.m, value: row.v }))} valueFmt={(v) => money(v, c)} />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 text-sm">
                <div><div className="label">Avg monthly burn</div><div className="font-medium tabular-nums">{money(avgBurn, c)}</div></div>
                <div><div className="label">Spent / budget</div><div className="font-medium tabular-nums">{pct(totPlanned ? (totActual / totPlanned) * 100 : 0)}</div></div>
                <div><div className="label">Runway at this rate</div><div className="font-medium tabular-nums">{runway === null ? "—" : runway > 120 ? "120+ months" : `${runway.toFixed(1)} months`}</div></div>
              </div>
              <div className="mt-3"><HBar label="Overall utilisation" value={totActual} max={totPlanned} money={`${money(totActual, c)} / ${money(totPlanned, c)}`} /></div>
            </>
          )}
        </div>

        <p className="text-xs" style={{ color: "var(--muted)" }}>
          Fund-accounting basis · figures derive from the project budget, recorded expenditures, commitments and disbursement vouchers · as at {fmtDate(fs.asOf)}.
        </p>
      </div>
    </div>
  );
}
