import Link from "next/link";
import { redirect } from "next/navigation";
import { requireHrOrg } from "../../../_guard";
import { q, one } from "@/server/db";
import { getEmployeeComp, getCompConfig } from "@/server/services/compensation";
import { upsertEmployeeCompAction } from "@/app/actions";
import { PageHeader, SectionTitle, Field, Badge, Stat } from "@/components/ui";
import { money } from "@/lib/format";
import { label } from "@/lib/enums";

export default async function PayeWizard({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const { orgId } = await requireHrOrg();
  const { id } = await params;
  const sp = await searchParams;
  const emp = await one<{ id: string; firstName: string; lastName: string; prefix: string | null; jobTitle: string | null; currency: string; contractType: string }>(
    `SELECT id, first_name AS "firstName", last_name AS "lastName", prefix, job_title AS "jobTitle", currency, contract_type AS "contractType" FROM employee WHERE id=$1 AND org_id=$2`, [id, orgId]
  );
  if (!emp) redirect("/hr/payroll/wizard");

  const comp = await getEmployeeComp(id);
  const config = comp?.config ?? (await getCompConfig(orgId));
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]);
  const v = comp?.row;
  const ben = comp?.benefits ?? [];
  const ded = comp?.deductionDefs ?? [];
  const ccy = v?.currency ?? emp.currency ?? "USD";
  const isConsultant = (v?.employmentType ?? "staff") === "consultant";
  const empName = `${emp.prefix ? emp.prefix + " " : ""}${emp.firstName} ${emp.lastName}`;
  const back = `/hr/payroll/wizard/${id}`;

  const StepHead = ({ n, title, hint }: { n: number; title: string; hint?: string }) => (
    <div className="flex items-start gap-3 mb-3 mt-5">
      <div style={{ width: 26, height: 26, borderRadius: 999, background: "var(--brand)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, flex: "0 0 auto" }}>{n}</div>
      <div><div className="font-display font-semibold">{title}</div>{hint && <div className="text-xs" style={{ color: "var(--muted)" }}>{hint}</div>}</div>
    </div>
  );

  return (
    <div className="max-w-5xl">
      <PageHeader title={`Pay setup — ${empName}`} subtitle={emp.jobTitle ?? undefined}
        actions={<div className="flex gap-2"><Link href="/hr/payroll/wizard" className="btn btn-sm">← All employees</Link><Link href="/hr/payroll" className="btn btn-sm">Payroll</Link></div>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved — the breakdown below has been recalculated.</div>}

      <div className="grid lg:grid-cols-2 gap-6">
        {/* ---- The wizard form ---- */}
        <form action={upsertEmployeeCompAction} className="card p-4">
          <input type="hidden" name="employeeId" value={id} />
          <input type="hidden" name="back" value={back} />

          <StepHead n={1} title="Employment & pay basis" hint="Is this a salaried staff member or a consultant, and what are they paid?" />
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Engagement"><select name="employmentType" defaultValue={v?.employmentType ?? (emp.contractType === "consultant" ? "consultant" : "staff")} className="select"><option value="staff">Salaried staff (PAYE &amp; NSSF)</option><option value="consultant">Consultant (withholding tax)</option></select></Field>
            <Field label="Currency"><input name="currency" defaultValue={ccy} className="input" /></Field>
            <div className="sm:col-span-2"><Field label="Charge to project (optional)"><select name="projectId" defaultValue={v?.projectId ?? ""} className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select></Field></div>
          </div>
          <div className="mt-3 p-3 rounded" style={{ background: "var(--surface)" }}>
            <div className="text-xs font-semibold mb-2" style={{ color: "var(--muted)" }}>FOR SALARIED STAFF</div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Gross monthly salary"><input type="number" step="0.01" name="grossSalary" defaultValue={v?.grossSalary ?? ""} className="input" placeholder="actually paid" /></Field>
              <Field label="Effort on this grant (%)"><input type="number" step="0.01" name="effortPct" defaultValue={v?.effortPct ?? 100} className="input" /></Field>
              <Field label="Base salary (for grant charge)"><input type="number" step="0.01" name="baseSalary" defaultValue={v?.baseSalary ?? ""} className="input" placeholder="optional — charged = base × effort" /></Field>
              <Field label="Calendar months"><input type="number" step="0.01" name="calMonths" defaultValue={v?.calMonths ?? ""} className="input" placeholder="informational" /></Field>
            </div>
            <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Enter the gross actually paid (PAYE &amp; NSSF are computed on this). Base salary is only for working out the grant-charged portion.</p>
          </div>
          <div className="mt-3 p-3 rounded" style={{ background: "var(--surface)" }}>
            <div className="text-xs font-semibold mb-2" style={{ color: "var(--muted)" }}>FOR CONSULTANTS</div>
            <Field label="Requested funds (gross)"><input type="number" step="0.01" name="requestedFunds" defaultValue={v?.requestedFunds ?? ""} className="input" placeholder={`withholding tax @ ${config.consultantWhtPct}% applies`} /></Field>
          </div>

          <StepHead n={2} title="Allowances & fringe benefits" hint="Employer-side costs that don't reduce take-home pay." />
          <div className="grid sm:grid-cols-3 gap-3">
            <Field label="Fringe amount"><input type="number" step="0.01" name="fringeAmount" defaultValue={v?.fringeAmount ?? ""} className="input" /></Field>
            <Field label="…or fringe rate (%)"><input type="number" step="0.01" name="fringeRatePct" defaultValue={v?.fringeRatePct ?? ""} className="input" /></Field>
            <Field label="Rate applies to"><select name="fringeBasis" defaultValue={v?.fringeBasis ?? "base"} className="select"><option value="base">Base salary</option><option value="charged">Charged salary</option></select></Field>
          </div>
          <div className="mt-2 space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid grid-cols-2 gap-2">
                <input name="benefitLabel" defaultValue={ben[i]?.label ?? ""} className="input" placeholder={i === 0 ? "Allowance (e.g. airtime)" : "Allowance"} />
                <input type="number" step="0.01" name="benefitAmount" defaultValue={ben[i]?.amount ?? ""} className="input" placeholder="amount" />
              </div>
            ))}
          </div>

          <StepHead n={3} title="Statutory deductions & PAYE" hint="These are taken from gross pay to give net pay." />
          <div className="grid sm:grid-cols-3 gap-3 text-sm">
            <Stat label="Employee NSSF" value={`${config.nssfEmployeePct}%`} sub="of gross" />
            <Stat label="Employer NSSF" value={`${config.nssfEmployerPct}%`} sub="employer cost" />
            <Stat label="PAYE method" value={config.payeMethod === "uganda" ? "Uganda bands" : config.payeMethod === "flat" ? `Flat ${config.payeFlatPct}%` : "None"} sub="marginal" />
          </div>
          <div className="mt-3">
            <Field label="Override PAYE rate (%) — optional"><input type="number" step="0.01" name="payeOverridePct" defaultValue={v?.payeOverridePct ?? ""} className="input" placeholder="leave blank to use the bands below" /></Field>
            <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>Only set this for a fixed-rate arrangement; otherwise the Uganda PAYE bands apply automatically and are shown in the breakdown.</p>
          </div>

          <StepHead n={4} title="Other deductions & savings" hint="SACCO, loans, local service tax, etc." />
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="grid grid-cols-3 gap-2">
                <input name="deductionLabel" defaultValue={ded[i]?.label ?? ""} className="input" placeholder={i === 0 ? "e.g. SACCO" : "label"} />
                <input type="number" step="0.01" name="deductionValue" defaultValue={ded[i]?.value ?? ""} className="input" placeholder="value" />
                <select name="deductionKind" defaultValue={ded[i]?.kind ?? "flat_deduction"} className="select">
                  <option value="flat_deduction">Flat — deduction</option>
                  <option value="flat_saving">Flat — saving</option>
                  <option value="pct_deduction">% of gross — deduction</option>
                  <option value="pct_saving">% of gross — saving</option>
                </select>
              </div>
            ))}
          </div>

          <div className="mt-4"><Field label="Note"><input name="note" defaultValue={v?.note ?? ""} className="input" /></Field></div>
          <div className="mt-4 flex justify-end"><button className="btn btn-primary" type="submit">Save &amp; recalculate</button></div>
        </form>

        {/* ---- The transparent breakdown ---- */}
        <div>
          <SectionTitle>How the pay is worked out</SectionTitle>
          {!comp ? (
            <div className="card p-4 text-sm" style={{ color: "var(--muted)" }}>Fill in the steps and press <strong>Save &amp; recalculate</strong> to see the full gross-to-net breakdown, including the PAYE band-by-band calculation.</div>
          ) : isConsultant ? (
            <div className="card p-4">
              <table className="w-full text-sm">
                <tbody>
                  <tr><td className="td">Requested funds (gross)</td><td className="td text-right tabular-nums">{money(comp.result.fundsRequested, ccy)}</td></tr>
                  <tr><td className="td">Less: withholding tax ({config.consultantWhtPct}%)</td><td className="td text-right tabular-nums" style={{ color: "var(--danger)" }}>({money(comp.result.wht, ccy)})</td></tr>
                  {comp.result.otherDeductions.filter((d) => !d.saving).map((d, i) => <tr key={i}><td className="td">Less: {d.label}</td><td className="td text-right tabular-nums" style={{ color: "var(--danger)" }}>({money(d.amount, ccy)})</td></tr>)}
                  <tr style={{ fontWeight: 700 }}><td className="td">Net paid to consultant</td><td className="td text-right tabular-nums">{money(comp.result.netPay, ccy)}</td></tr>
                </tbody>
              </table>
            </div>
          ) : (
            <>
              <div className="card p-4 mb-4">
                <table className="w-full text-sm">
                  <tbody>
                    <tr><td className="td">Gross pay</td><td className="td text-right tabular-nums">{money(comp.result.gross, ccy)}</td></tr>
                    <tr><td className="td">Less: employee NSSF ({config.nssfEmployeePct}%)</td><td className="td text-right tabular-nums" style={{ color: "var(--danger)" }}>({money(comp.result.employeeNSSF, ccy)})</td></tr>
                    <tr><td className="td">Less: PAYE</td><td className="td text-right tabular-nums" style={{ color: "var(--danger)" }}>({money(comp.result.paye, ccy)})</td></tr>
                    {comp.result.otherDeductions.filter((d) => !d.saving).map((d, i) => <tr key={`d${i}`}><td className="td">Less: {d.label}</td><td className="td text-right tabular-nums" style={{ color: "var(--danger)" }}>({money(d.amount, ccy)})</td></tr>)}
                    {comp.result.otherDeductions.filter((d) => d.saving).map((d, i) => <tr key={`s${i}`}><td className="td">Less: {d.label} (saving)</td><td className="td text-right tabular-nums" style={{ color: "var(--danger)" }}>({money(d.amount, ccy)})</td></tr>)}
                    <tr style={{ fontWeight: 700, borderTop: "2px solid var(--border)" }}><td className="td">Net take-home pay</td><td className="td text-right tabular-nums">{money(comp.result.netPay, ccy)}</td></tr>
                  </tbody>
                </table>
                <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Employer also contributes NSSF of {money(comp.result.employerNSSF, ccy)}. Total employer cost: {money(comp.result.employerCost, ccy)}.</p>
              </div>

              <SectionTitle>PAYE — band by band</SectionTitle>
              <div className="card overflow-x-auto">
                {comp.paye.method === "none" ? <p className="p-4 text-sm" style={{ color: "var(--muted)" }}>PAYE is switched off for this organisation.</p>
                : v?.payeOverridePct != null ? <p className="p-4 text-sm" style={{ color: "var(--muted)" }}>A fixed PAYE rate of {v.payeOverridePct}% applies to this employee, so the bands are not used. PAYE = {money(comp.result.paye, ccy)}.</p>
                : (
                <table className="w-full text-sm">
                  <thead><tr><th className="th text-left">Income band (monthly)</th><th className="th text-right">Rate</th><th className="th text-right">In band</th><th className="th text-right">Tax</th></tr></thead>
                  <tbody>
                    {comp.paye.rows.map((b, i) => (
                      <tr key={i}>
                        <td className="td">{money(b.from, ccy)} – {b.to == null ? "above" : money(b.to, ccy)}{b.note ? <span className="text-xs ml-1" style={{ color: "var(--muted)" }}>({b.note})</span> : null}</td>
                        <td className="td text-right tabular-nums">{Math.round(b.rate * 100)}%</td>
                        <td className="td text-right tabular-nums">{money(b.amountInBand, ccy)}</td>
                        <td className="td text-right tabular-nums">{money(b.tax, ccy)}</td>
                      </tr>
                    ))}
                    <tr style={{ fontWeight: 700 }}><td className="td" colSpan={3}>Total PAYE</td><td className="td text-right tabular-nums">{money(comp.paye.total, ccy)}</td></tr>
                  </tbody>
                </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
