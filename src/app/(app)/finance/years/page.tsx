import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { addFinancialYearAction, setCurrentFinancialYearAction, deleteFinancialYearAction } from "@/app/actions";

export default async function FinancialYearsPage({ searchParams }: { searchParams: Promise<{ saved?: string; err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;
  const currency = (await one<{ currency: string }>(`SELECT currency FROM project WHERE org_id=$1 ORDER BY created_at LIMIT 1`, [orgId]))?.currency ?? "USD";

  const years = await q<{ id: string; name: string; startDate: string; endDate: string; isCurrent: boolean; note: string | null }>(
    `SELECT id, name, start_date AS "startDate", end_date AS "endDate", is_current AS "isCurrent", note
     FROM financial_year WHERE org_id=$1 ORDER BY start_date DESC`, [orgId]
  );

  // Per-year financial summary: project spend, sub-award disbursements and the
  // count of posted journal entries falling inside each year's date range.
  const summaries = new Map<string, { spend: number; spendCount: number; subaward: number; entries: number }>();
  for (const y of years) {
    const spend = await one<{ s: number; c: number }>(
      `SELECT COALESCE(SUM(e.amount),0)::float s, COUNT(*)::int c FROM expenditure e
       JOIN project p ON p.id=e.project_id WHERE p.org_id=$1 AND e.date::date BETWEEN $2 AND $3`, [orgId, y.startDate, y.endDate]);
    const sub = await one<{ s: number }>(
      `SELECT COALESCE(SUM(sp.amount),0)::float s FROM subaward_payment sp
       JOIN subaward s ON s.id=sp.subaward_id WHERE s.org_id=$1 AND sp.paid_on BETWEEN $2 AND $3`, [orgId, y.startDate, y.endDate]);
    const je = await one<{ c: number }>(
      `SELECT COUNT(*)::int c FROM journal_entry WHERE org_id=$1 AND entry_date BETWEEN $2 AND $3`, [orgId, y.startDate, y.endDate]);
    summaries.set(y.id, { spend: spend?.s ?? 0, spendCount: spend?.c ?? 0, subaward: sub?.s ?? 0, entries: je?.c ?? 0 });
  }

  return (
    <div className="max-w-5xl">
      <PageHeader title="Financial years" subtitle={`Accounting periods for ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.err === "fields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Name, start and end dates are all required.</div>}

      <SectionTitle>Defined years &amp; summary</SectionTitle>
      {years.length === 0 ? <Empty title="No financial years yet" hint="Add your first accounting period below — for example FY2025/26 running 1 Jul 2025 to 30 Jun 2026." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Year</th><th className="th text-left">Period</th>
              <th className="th text-right">Project spend</th><th className="th text-right">Sub-award paid</th>
              <th className="th text-right">Journal entries</th><th className="th" />
            </tr></thead>
            <tbody>
              {years.map((y) => {
                const s = summaries.get(y.id)!;
                return (
                  <tr key={y.id}>
                    <td className="td"><span className="font-medium">{y.name}</span> {y.isCurrent && <Badge tone="ok">current</Badge>}</td>
                    <td className="td">{fmtDate(y.startDate)} – {fmtDate(y.endDate)}</td>
                    <td className="td text-right tabular-nums">{money(s.spend, currency)}<span className="text-xs block" style={{ color: "var(--muted)" }}>{s.spendCount} items</span></td>
                    <td className="td text-right tabular-nums">{money(s.subaward, currency)}</td>
                    <td className="td text-right tabular-nums">{s.entries}</td>
                    <td className="td text-right whitespace-nowrap">
                      {!y.isCurrent && (
                        <form action={setCurrentFinancialYearAction} className="inline">
                          <input type="hidden" name="yearId" value={y.id} />
                          <button className="btn btn-sm" type="submit">Set current</button>
                        </form>
                      )}{" "}
                      <form action={deleteFinancialYearAction} className="inline">
                        <input type="hidden" name="yearId" value={y.id} />
                        <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs mb-6" style={{ color: "var(--muted)" }}>Spend and sub-award figures are the totals dated within each year&apos;s period (currency {currency}).</p>

      <SectionTitle>Add a financial year</SectionTitle>
      <form action={addFinancialYearAction} className="card p-4 grid sm:grid-cols-3 gap-3 items-end">
        <Field label="Name"><input name="name" required className="input" placeholder="FY2025/26" /></Field>
        <Field label="Start date"><input type="date" name="startDate" required className="input" /></Field>
        <Field label="End date"><input type="date" name="endDate" required className="input" /></Field>
        <div className="sm:col-span-2"><Field label="Note (optional)"><input name="note" className="input" /></Field></div>
        <label className="flex items-center gap-2 text-sm pb-2"><input type="checkbox" name="isCurrent" /> Set as current year</label>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Add year</button></div>
      </form>
    </div>
  );
}
