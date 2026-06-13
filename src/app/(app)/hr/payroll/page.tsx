import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { q, one } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money } from "@/lib/format";
import { label } from "@/lib/enums";
import { addPayComponentAction, togglePayComponentAction, buildPayrollAction, finalisePayrollAction } from "@/app/actions";

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ comp?: string; run?: string; finalised?: string; err?: string }> }) {
  const { orgId } = await requireHrOrg();
  const sp = await searchParams;
  const components = await q<{ id: string; name: string; kind: string; amountType: string; rate: number; basis: string; appliesDefault: boolean; active: boolean }>(
    `SELECT id, name, kind, amount_type AS "amountType", rate::float, basis, applies_default AS "appliesDefault", active FROM pay_component WHERE org_id=$1 ORDER BY kind, name`, [orgId]
  );
  const runs = await q<{ id: string; periodLabel: string; status: string; totalGross: number; totalDeductions: number; totalNet: number }>(
    `SELECT id, period_label AS "periodLabel", status, total_gross::float AS "totalGross", total_deductions::float AS "totalDeductions", total_net::float AS "totalNet" FROM payroll_run WHERE org_id=$1 ORDER BY period_label DESC LIMIT 12`, [orgId]
  );

  // if a run is selected, show its payslips
  const selectedRun = sp.run ? await one<{ id: string; periodLabel: string; status: string }>(`SELECT id, period_label AS "periodLabel", status FROM payroll_run WHERE org_id=$1 AND period_label=$2`, [orgId, sp.run]) : null;
  const slips = selectedRun ? await q<{ id: string; emp: string; basic: number; gross: number; deductions: number; net: number; currency: string }>(
    `SELECT ps.id, e.first_name || ' ' || e.last_name AS emp, ps.basic::float, ps.gross::float, ps.deductions::float, ps.net::float, ps.currency
     FROM payslip ps JOIN employee e ON e.id=ps.employee_id WHERE ps.run_id=$1 ORDER BY e.last_name`, [selectedRun.id]
  ) : [];
  const thisMonth = new Date().toISOString().slice(0, 7);

  return (
    <div className="max-w-5xl">
      <PageHeader title="Payroll" subtitle="Configurable components, monthly runs & payslips" actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.comp && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Pay component added.</div>}
      {sp.finalised && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Payroll run finalised.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.err)}</div>}

      <SectionTitle>Pay components (allowances &amp; deductions)</SectionTitle>
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>You define the rules — PAYE, NSSF, allowances — as flat amounts or percentages of basic/gross. Nothing is hard-coded, so they always match your institution&apos;s current rates.</p>
      {components.length > 0 && (
        <div className="card overflow-x-auto mb-4">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Name</th><th className="th text-left">Type</th><th className="th text-left">Amount</th><th className="th text-left">Applies</th><th className="th" /></tr></thead>
            <tbody>
              {components.map((c) => (
                <tr key={c.id} style={{ opacity: c.active ? 1 : 0.5 }}>
                  <td className="td">{c.name}</td>
                  <td className="td"><Badge tone={c.kind === "earning" ? "ok" : "muted"}>{c.kind}</Badge></td>
                  <td className="td">{c.amountType === "percent" ? `${c.rate}% of ${c.basis}` : money(c.rate, "")}</td>
                  <td className="td">{c.appliesDefault ? "All staff" : "Assigned only"}</td>
                  <td className="td text-right"><form action={togglePayComponentAction}><input type="hidden" name="componentId" value={c.id} /><button className="btn btn-sm" type="submit">{c.active ? "Disable" : "Enable"}</button></form></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form action={addPayComponentAction} className="card p-4 grid sm:grid-cols-5 gap-3 items-end mb-6">
        <Field label="Name"><input name="name" required className="input" placeholder="PAYE / NSSF / Housing" /></Field>
        <Field label="Kind"><select name="kind" className="select"><option value="deduction">Deduction</option><option value="earning">Allowance (earning)</option></select></Field>
        <Field label="Amount type"><select name="amountType" className="select"><option value="flat">Flat amount</option><option value="percent">Percentage</option></select></Field>
        <Field label="Rate (amount or %)"><input type="number" step="0.0001" name="rate" required className="input" /></Field>
        <Field label="Percent of"><select name="basis" className="select"><option value="basic">Basic</option><option value="gross">Gross</option></select></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="appliesDefault" defaultChecked /> Apply to all staff</label>
        <div className="sm:col-span-5 flex justify-end"><button className="btn btn-primary" type="submit">Add component</button></div>
      </form>

      <SectionTitle>Payroll runs</SectionTitle>
      <form action={buildPayrollAction} className="card p-4 flex items-end gap-3 mb-4">
        <Field label="Period (YYYY-MM)"><input name="period" defaultValue={thisMonth} className="input" style={{ width: 140 }} /></Field>
        <button className="btn btn-primary" type="submit">Build / recompute run</button>
        <span className="text-xs pb-2" style={{ color: "var(--muted)" }}>Generates a payslip per active employee from the components above.</span>
      </form>
      {runs.length === 0 ? <Empty title="No payroll runs yet" hint="Build one for the current month above." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Period</th><th className="th text-left">Status</th><th className="th text-right">Gross</th><th className="th text-right">Deductions</th><th className="th text-right">Net</th><th className="th" /></tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="td font-mono">{r.periodLabel}</td>
                  <td className="td"><Badge tone={r.status === "finalised" ? "ok" : "warn"}>{label(r.status)}</Badge></td>
                  <td className="td text-right tabular-nums">{money(r.totalGross, "")}</td>
                  <td className="td text-right tabular-nums">{money(r.totalDeductions, "")}</td>
                  <td className="td text-right tabular-nums font-medium">{money(r.totalNet, "")}</td>
                  <td className="td text-right whitespace-nowrap">
                    <div className="flex gap-1 justify-end">
                      <Link href={`/hr/payroll?run=${r.periodLabel}`} className="btn btn-sm">View slips</Link>
                      {r.status !== "finalised" && <form action={finalisePayrollAction}><input type="hidden" name="runId" value={r.id} /><button className="btn btn-sm btn-primary" type="submit">Finalise</button></form>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedRun && (
        <>
          <SectionTitle>Payslips — {selectedRun.periodLabel}</SectionTitle>
          {slips.length === 0 ? <Empty title="No payslips in this run" hint="Add employees with a basic salary, then recompute." /> : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr><th className="th text-left">Employee</th><th className="th text-right">Basic</th><th className="th text-right">Gross</th><th className="th text-right">Deductions</th><th className="th text-right">Net</th><th className="th" /></tr></thead>
                <tbody>
                  {slips.map((s) => (
                    <tr key={s.id}>
                      <td className="td">{s.emp}</td>
                      <td className="td text-right tabular-nums">{money(s.basic, s.currency)}</td>
                      <td className="td text-right tabular-nums">{money(s.gross, s.currency)}</td>
                      <td className="td text-right tabular-nums">{money(s.deductions, s.currency)}</td>
                      <td className="td text-right tabular-nums font-medium">{money(s.net, s.currency)}</td>
                      <td className="td text-right"><a href={`/print/payslip/${s.id}`} target="_blank" rel="noopener" className="btn btn-sm">🖨 Slip</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
