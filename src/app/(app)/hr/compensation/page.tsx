import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { getCompConfig, orgCompensation } from "@/server/services/compensation";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat } from "@/components/ui";
import { money } from "@/lib/format";
import { saveCompConfigAction } from "@/app/actions";

export default async function CompensationPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const sp = await searchParams;
  const cfg = await getCompConfig(orgId);
  const { byCurrency, rows } = await orgCompensation(orgId);

  return (
    <div className="max-w-6xl">
      <PageHeader title="Compensation" subtitle={`Grant-model payroll for ${orgName} — gross, fringe, NSSF, PAYE & effort`}
        actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}

      <div className="card p-3 mb-6 text-sm" style={{ borderColor: "var(--border)" }}>
        <strong>How this differs from the monthly payroll.</strong> Here the institution enters the <em>gross actually paid</em> (or base + % effort for grant charging) plus a fringe pool. Employee NSSF and PAYE are deducted from gross to give net pay. <strong>Employer NSSF is a saving funded from the fringe pool — it never inflates gross or net.</strong> Consultants are withheld only (no NSSF/PAYE). Set a person's figures on their employee profile.
      </div>

      {/* Configurable rates */}
      <SectionTitle>Rates &amp; method</SectionTitle>
      <form action={saveCompConfigAction} className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
        <Field label="Employer NSSF %"><input type="number" step="0.01" name="nssfEmployerPct" defaultValue={cfg.nssfEmployerPct} className="input" /></Field>
        <Field label="Employee NSSF %"><input type="number" step="0.01" name="nssfEmployeePct" defaultValue={cfg.nssfEmployeePct} className="input" /></Field>
        <Field label="Consultant withholding %"><input type="number" step="0.01" name="consultantWhtPct" defaultValue={cfg.consultantWhtPct} className="input" /></Field>
        <Field label="PAYE method"><select name="payeMethod" defaultValue={cfg.payeMethod} className="select"><option value="uganda">Uganda bands</option><option value="flat">Flat %</option><option value="none">None</option></select></Field>
        <Field label="PAYE flat % (if flat)"><input type="number" step="0.01" name="payeFlatPct" defaultValue={cfg.payeFlatPct} className="input" /></Field>
        <div />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="nssfEmployerFromFringe" defaultChecked={cfg.nssfEmployerFromFringe} /> Employer NSSF drawn from fringe pool</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="nssfEmployeeFromFringe" defaultChecked={cfg.nssfEmployeeFromFringe} /> Employee NSSF from fringe (not gross)</label>
        <div className="sm:col-span-3 flex items-center justify-between">
          <span className="text-xs" style={{ color: "var(--muted)" }}>Statutory NSSF in Uganda is 10% employer / 5% employee — adjust to match your policy. Nothing is hard-coded.</span>
          <button className="btn btn-primary" type="submit">Save rates</button>
        </div>
      </form>

      {/* Organisation roll-up, per currency */}
      <SectionTitle>Organisation totals</SectionTitle>
      {byCurrency.length === 0 ? (
        <Empty title="No compensation recorded yet" hint="Set gross, fringe and effort on each employee's profile (HR → Employees). Totals roll up here by currency." />
      ) : (
        <div className="space-y-6 mb-6">
          {byCurrency.map((r) => (
            <div key={r.currency}>
              <div className="text-sm font-medium mb-2">{r.currency} · {r.headcount} {r.headcount === 1 ? "person" : "people"} ({r.staff} staff, {r.consultants} consultant{r.consultants === 1 ? "" : "s"})</div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <Stat label="Funds requested" value={money(r.fundsRequested, r.currency)} sub="charged salary + fringe" />
                <Stat label="Net pay" value={money(r.netPay, r.currency)} sub="take-home (after NSSF + PAYE)" />
                <Stat label="NSSF saving" value={money(r.nssfSavings, r.currency)} sub={`employee ${money(r.employeeNSSF, r.currency)} + employer ${money(r.employerNSSF, r.currency)}`} />
                <Stat label="Taxes" value={money(r.taxes, r.currency)} sub={`PAYE ${money(r.paye, r.currency)} · WHT ${money(r.wht, r.currency)}`} />
                <Stat label="Fringe pool" value={money(r.fringePool, r.currency)} />
                <Stat label="Fringe used" value={money(r.fringeUsed, r.currency)} />
                <Stat label="Fringe unused" value={money(r.fringeUnused, r.currency)} tone={r.fringeUnused > 0 ? "ok" : undefined} />
                <Stat label="Employer cost" value={money(r.employerCost, r.currency)} sub="gross + employer NSSF + benefits" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-employee / per-project breakdown */}
      {rows.length > 0 && (
        <>
          <SectionTitle>By employee &amp; project</SectionTitle>
          <div className="card overflow-x-auto mb-6">
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left">Person</th>
                <th className="th text-left">Project</th>
                <th className="th text-left">Type</th>
                <th className="th text-right">Gross / funds</th>
                <th className="th text-right">Net</th>
                <th className="th text-right">Empl. NSSF</th>
                <th className="th text-right">Empr. NSSF</th>
                <th className="th text-right">PAYE / WHT</th>
                <th className="th text-right">Fringe (unused)</th>
                <th className="th text-right">Funds req.</th>
              </tr></thead>
              <tbody>
                {rows.map(({ row, result }) => (
                  <tr key={row.id}>
                    <td className="td font-medium">{result.name}</td>
                    <td className="td">{row.projectCode ? <Link href={`/projects/${row.projectId}`} className="hover:underline" style={{ color: "var(--brand)" }}>{row.projectCode}</Link> : <span style={{ color: "var(--muted)" }}>—</span>}</td>
                    <td className="td">{row.employmentType === "consultant" ? <Badge tone="info">consultant</Badge> : <Badge tone="muted">staff</Badge>}</td>
                    <td className="td text-right tabular-nums">{money(result.gross, row.currency)}</td>
                    <td className="td text-right tabular-nums">{money(result.netPay, row.currency)}</td>
                    <td className="td text-right tabular-nums">{money(result.employeeNSSF, row.currency)}</td>
                    <td className="td text-right tabular-nums">{money(result.employerNSSF, row.currency)}</td>
                    <td className="td text-right tabular-nums">{money(result.paye + result.wht, row.currency)}</td>
                    <td className="td text-right tabular-nums" style={{ color: result.fringeOverspent > 0 ? "var(--danger)" : undefined }}>{money(result.fringeOverspent > 0 ? -result.fringeOverspent : result.fringeUnused, row.currency)}</td>
                    <td className="td text-right tabular-nums font-medium">{money(result.fundsRequested, row.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs" style={{ color: "var(--muted)" }}>Edit a person's figures on their profile under HR → Employees → open the employee → Compensation (grant model).</p>
        </>
      )}
    </div>
  );
}
