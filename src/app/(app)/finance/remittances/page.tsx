import Link from "next/link";
import { requireFinanceOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { addStatutoryRemittanceAction, markRemittancePaidAction, deleteStatutoryRemittanceAction } from "@/app/actions";

const TYPE_LABEL: Record<string, string> = { paye: "PAYE", nssf: "NSSF", lst: "LST", wht: "Withholding tax" };

export default async function RemittancesPage({ searchParams }: { searchParams: Promise<{ saved?: string; err?: string }> }) {
  const { orgId, orgName } = await requireFinanceOrg();
  const sp = await searchParams;

  const rows = await q<{ id: string; period: string; taxType: string; amount: number; currency: string; dueDate: string; paidOn: string | null; reference: string | null; daysOverdue: number }>(
    `SELECT id, period, tax_type AS "taxType", amount::float AS amount, currency,
            due_date AS "dueDate", paid_on AS "paidOn", reference,
            CASE WHEN paid_on IS NULL THEN GREATEST(0,(CURRENT_DATE - due_date))::int ELSE 0 END AS "daysOverdue"
     FROM statutory_remittance WHERE org_id=$1 ORDER BY due_date DESC`, [orgId]
  );
  const baseCcy = (await q<{ c: string }>(`SELECT COALESCE(base_currency,'USD') c FROM organization WHERE id=$1`, [orgId]))[0]?.c ?? "USD";
  const outstanding = rows.filter((r) => !r.paidOn);
  const overdue = outstanding.filter((r) => r.daysOverdue > 0);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Statutory remittances" subtitle={`PAYE, NSSF & LST filing register · ${orgName}`} actions={<Link href="/finance" className="btn btn-sm">← Finance</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.err === "fields" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A pay period (YYYY-MM) is required.</div>}

      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="Outstanding filings" value={String(outstanding.length)} tone={outstanding.length ? "warn" : undefined} />
        <Stat label="Overdue" value={String(overdue.length)} tone={overdue.length ? "danger" : "ok"} />
        <Stat label="Filed" value={String(rows.length - outstanding.length)} />
      </div>
      <p className="text-sm mb-5" style={{ color: "var(--muted)" }}>
        PAYE and NSSF must be remitted by the 15th of the month following the pay period. Record each filing here with its URA/NSSF receipt so nothing slips past its deadline.
      </p>

      <SectionTitle>Register</SectionTitle>
      {rows.length === 0 ? <Empty title="No remittances recorded" hint="Add the first PAYE/NSSF filing below." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr>
              <th className="th text-left">Period</th><th className="th text-left">Tax</th>
              <th className="th text-right">Amount</th><th className="th text-left">Due</th>
              <th className="th text-left">Status</th><th className="th text-left">Receipt</th><th className="th" />
            </tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="td font-mono text-xs">{r.period}</td>
                  <td className="td">{TYPE_LABEL[r.taxType] ?? r.taxType}</td>
                  <td className="td text-right tabular-nums">{money(r.amount, r.currency)}</td>
                  <td className="td">{fmtDate(r.dueDate)}</td>
                  <td className="td">
                    {r.paidOn ? <Badge tone="ok">Filed {fmtDate(r.paidOn)}</Badge>
                      : r.daysOverdue > 0 ? <Badge tone="danger">Overdue {r.daysOverdue}d</Badge>
                      : <Badge tone="warn">Due</Badge>}
                  </td>
                  <td className="td text-xs">{r.reference ?? "—"}</td>
                  <td className="td text-right whitespace-nowrap">
                    {!r.paidOn && (
                      <form action={markRemittancePaidAction} className="inline-flex items-end gap-1">
                        <input type="hidden" name="remittanceId" value={r.id} />
                        <input name="reference" placeholder="Receipt #" className="input" style={{ width: 110, padding: "2px 6px" }} />
                        <button className="btn btn-sm" type="submit">Mark filed</button>
                      </form>
                    )}{" "}
                    <form action={deleteStatutoryRemittanceAction} className="inline">
                      <input type="hidden" name="remittanceId" value={r.id} />
                      <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Record a remittance</SectionTitle>
      <form action={addStatutoryRemittanceAction} className="card p-4 grid sm:grid-cols-3 gap-3 items-end">
        <Field label="Pay period (YYYY-MM)"><input name="period" required placeholder="2026-05" className="input" /></Field>
        <Field label="Tax"><select name="taxType" className="select"><option value="paye">PAYE</option><option value="nssf">NSSF</option><option value="lst">LST</option><option value="wht">Withholding tax</option></select></Field>
        <Field label="Amount"><input type="number" step="0.01" name="amount" className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue={baseCcy} className="input" /></Field>
        <Field label="Due date (defaults to 15th of next month)"><input type="date" name="dueDate" className="input" /></Field>
        <Field label="Filed on (if already paid)"><input type="date" name="paidOn" className="input" /></Field>
        <div className="sm:col-span-2"><Field label="Receipt / reference"><input name="reference" className="input" /></Field></div>
        <div className="flex justify-end"><button className="btn btn-primary" type="submit">Add</button></div>
      </form>
    </div>
  );
}
