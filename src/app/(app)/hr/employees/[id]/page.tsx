import Link from "next/link";
import { requireHrOrg } from "../../_guard";
import { q, one } from "@/server/db";
import { leaveBalance } from "@/server/services/hr";
import { getEmployeeComp } from "@/server/services/compensation";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { updateEmployeeAction, assignEmployeeDepartmentAction, createEmployeeLoginAction,
  updateEmployeeProfileAction, addEmployeeEducationAction, deleteEmployeeEducationAction,
  addEmployeePolicyAction, deleteEmployeePolicyAction, requestHrActionAction, decideHrActionAction,
  upsertEmployeeCompAction, upsertEmployeeProjectAction, removeEmployeeProjectAction,
  generateResponsibilitiesFromDocAction, uploadEmployeeDocumentAction, deleteEmployeeDocumentAction } from "@/app/actions";
import { dateInput } from "@/lib/format";
import { COMMON_DEPARTMENTS } from "@/lib/departments";

export default async function EmployeeDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; login?: string; loginerr?: string; hra?: string; err?: string; docuploaded?: string; docdeleted?: string; docerr?: string; generated?: string; generr?: string }> }) {
  const { id } = await params;
  const { orgId } = await requireHrOrg();
  const sp = await searchParams;
  const e = await one<{
    id: string; staffNo: string | null; firstName: string; lastName: string; email: string | null; phone: string | null;
    jobTitle: string | null; department: string | null; departmentId: string | null; contractType: string; startDate: string | null; endDate: string | null;
    basicSalary: number; currency: string; bankName: string | null; bankAccount: string | null; bankBranch: string | null;
    mobileMoney: string | null; annualLeaveDays: number; status: string; userId: string | null;
  }>(
    `SELECT id, staff_no AS "staffNo", first_name AS "firstName", last_name AS "lastName", email, phone,
            job_title AS "jobTitle", department, department_id AS "departmentId", contract_type AS "contractType", start_date AS "startDate", end_date AS "endDate",
            basic_salary::float AS "basicSalary", currency, bank_name AS "bankName", bank_account AS "bankAccount",
            bank_branch AS "bankBranch", mobile_money AS "mobileMoney", annual_leave_days::float AS "annualLeaveDays", status, user_id AS "userId"
     FROM employee WHERE id=$1 AND org_id=$2`, [id, orgId]
  );
  if (!e) return <Empty title="Employee not found" hint="They may have been removed." />;
  const departments = await q<{ id: string; name: string }>(`SELECT id, name FROM department WHERE org_id=$1 ORDER BY name`, [orgId]);
  // rich profile: full demographic fields, education, policy numbers, pending HR action
  const demo = (await one<{
    prefix: string | null; gender: string | null; maritalStatus: string | null; nationality: string | null;
    dateOfBirth: string | null; nationalId: string | null; nssfNumber: string | null; tinNumber: string | null; address: string | null;
    nextOfKin: string | null; nextOfKinRelationship: string | null; nextOfKinPhone: string | null; nextOfKinAddress: string | null;
  }>(
    `SELECT prefix, gender, marital_status AS "maritalStatus", nationality, date_of_birth AS "dateOfBirth",
            national_id AS "nationalId", nssf_number AS "nssfNumber", tin_number AS "tinNumber", address,
            next_of_kin AS "nextOfKin", next_of_kin_relationship AS "nextOfKinRelationship",
            next_of_kin_phone AS "nextOfKinPhone", next_of_kin_address AS "nextOfKinAddress"
     FROM employee WHERE id=$1`, [id]
  ))!;
  const education = await q<{ id: string; kind: string; qualification: string; institution: string | null; yearObtained: string | null }>(
    `SELECT id, kind, qualification, institution, year_obtained AS "yearObtained" FROM employee_education WHERE employee_id=$1 ORDER BY year_obtained DESC NULLS LAST`, [id]
  );
  const policies = await q<{ id: string; label: string; value: string; note: string | null }>(
    `SELECT id, label, value, note FROM employee_policy_number WHERE employee_id=$1 ORDER BY label`, [id]
  );
  const pendingAction = await one<{ id: string; actionType: string; reason: string | null; requestedByName: string | null; status: string }>(
    `SELECT id, action_type AS "actionType", reason, requested_by_name AS "requestedByName", status FROM hr_action_request WHERE employee_id=$1 AND status='pending' ORDER BY created_at DESC LIMIT 1`, [id]
  );
  const PREFIXES = ["", "Dr", "Prof", "Assoc. Prof", "Assist. Prof", "Mr", "Ms", "Mrs", "Sr", "Rev"];
  const lb = await leaveBalance(id);
  const comp = await getEmployeeComp(id);
  const projects = await q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY created_at DESC`, [orgId]);
  const employeeProjects = await q<{ id: string; projectId: string; code: string; title: string; role: string | null; responsibilities: string | null }>(
    `SELECT ep.id, ep.project_id AS "projectId", p.code, p.title, ep.role, ep.responsibilities
     FROM employee_project ep JOIN project p ON p.id=ep.project_id WHERE ep.employee_id=$1 ORDER BY p.code`, [id]
  );
  const assignedProjectIds = new Set(employeeProjects.map((a) => a.projectId));
  const assignableProjects = projects.filter((p) => !assignedProjectIds.has(p.id));
  const deptOptions = Array.from(new Map([...departments.map((d) => d.name), ...COMMON_DEPARTMENTS].map((n) => [n.toLowerCase(), n])).values());
  const empDocs = await q<{ id: string; name: string; docType: string; createdAt: string }>(
    `SELECT id, name, doc_type AS "docType", created_at AS "createdAt" FROM employee_document WHERE employee_id=$1 ORDER BY created_at DESC`, [id]
  );
  const recentLeave = await q<{ leaveType: string; startDate: string; endDate: string; days: number; status: string }>(
    `SELECT leave_type AS "leaveType", start_date AS "startDate", end_date AS "endDate", days::float, status FROM leave_request WHERE employee_id=$1 ORDER BY start_date DESC LIMIT 5`, [id]
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title={`${demo.prefix ? `${demo.prefix} ` : ""}${e.firstName} ${e.lastName}`} subtitle={`${e.jobTitle ?? "—"}${e.department ? ` · ${e.department}` : ""}`} actions={<Link href="/hr/employees" className="btn btn-sm">← Employees</Link>} />
      {sp.saved && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Saved.</div>}
      {sp.login === "sent" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Self-service login created — an invite email with a set-password link has been sent.</div>}
      {sp.login === "exists" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)", borderColor: "var(--border)" }}>This employee already has a login.</div>}
      {sp.login === "failed" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--warn)", borderColor: "var(--warn)" }}>Login created, but the invite email could not be sent. They can use “forgot password” to set one.</div>}
      {sp.loginerr && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.loginerr)}</div>}

      {/* Login + department */}
      <div className="grid sm:grid-cols-2 gap-4 mb-6">
        <div className="card p-4">
          <div className="font-medium mb-2">Self-service login</div>
          {e.userId ? (
            <p className="text-sm" style={{ color: "var(--muted)" }}>This employee has a portal login linked. They can sign in to fill timesheets, request leave, raise purchase requests, and manage their own profile &amp; documents.</p>
          ) : (
            <>
              <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>{e.email ? "Create a restricted portal login and email them an invite to set a password." : "Add an email address (below) before creating a login."}</p>
              {e.email && <form action={createEmployeeLoginAction}><input type="hidden" name="employeeId" value={e.id} /><button className="btn btn-primary btn-sm" type="submit">Create portal login</button></form>}
            </>
          )}
        </div>
        <div className="card p-4">
          <div className="font-medium mb-2">Department</div>
          <form action={assignEmployeeDepartmentAction} className="flex items-end gap-2">
            <input type="hidden" name="employeeId" value={e.id} />
            <input name="departmentName" list="emp-dept-options" defaultValue={e.department ?? ""} className="input" placeholder="Pick or type a department…" />
            <datalist id="emp-dept-options">{deptOptions.map((n) => <option key={n} value={n} />)}</datalist>
            <button className="btn btn-sm" type="submit">Assign</button>
          </form>
          <p className="text-xs mt-2" style={{ color: "var(--muted)" }}>Pick a common one or type a new department — it&apos;ll be created automatically. Leave blank to unassign.</p>
        </div>
      </div>

      <div className="grid sm:grid-cols-4 gap-3 mb-6">
        <div className="card p-3"><div className="label">Basic salary</div><div className="font-semibold tabular-nums">{money(e.basicSalary, e.currency)}</div></div>
        <div className="card p-3"><div className="label">Net pay (grant model)</div><div className="font-semibold tabular-nums">{comp ? money(comp.result.netPay, comp.row.currency) : "—"}</div></div>
        <div className="card p-3"><div className="label">Leave remaining</div><div className="font-semibold">{lb.remaining} / {lb.entitlement} days</div></div>
        <div className="card p-3"><div className="label">Status</div><div className="font-semibold">{label(e.status)}</div></div>
      </div>

      {/* compensation — grant model (gross + fringe + effort; NSSF as a saving funded from fringe) */}
      <SectionTitle>Compensation (grant model)</SectionTitle>
      {comp ? (
        <div className="grid md:grid-cols-2 gap-4 mb-6">
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {comp.row.employmentType === "consultant" ? (
                  <>
                    <tr style={{ fontWeight: 600 }}><td className="td">Requested funds</td><td className="td text-right tabular-nums">{money(comp.result.gross, comp.row.currency)}</td></tr>
                    <tr><td className="td">− Withholding tax ({comp.config.consultantWhtPct}%)</td><td className="td text-right tabular-nums">({money(comp.result.wht, comp.row.currency)})</td></tr>
                    {comp.result.otherDeductions.map((d, i) => <tr key={`cod${i}`}><td className="td">− {d.label}{d.saving ? " (saving)" : ""}</td><td className="td text-right tabular-nums">({money(d.amount, comp.row.currency)})</td></tr>)}
                    <tr style={{ fontWeight: 700 }}><td className="td">Net to consultant</td><td className="td text-right tabular-nums">{money(comp.result.netPay, comp.row.currency)}</td></tr>
                  </>
                ) : (
                  <>
                    <tr style={{ fontWeight: 600 }}><td className="td">Gross salary</td><td className="td text-right tabular-nums">{money(comp.result.gross, comp.row.currency)}</td></tr>
                    <tr><td className="td">− Employee NSSF ({comp.config.nssfEmployeePct}%)</td><td className="td text-right tabular-nums">({money(comp.result.employeeNSSF, comp.row.currency)})</td></tr>
                    <tr><td className="td">− PAYE{comp.row.payeOverridePct != null ? ` (${comp.row.payeOverridePct}%)` : ""}</td><td className="td text-right tabular-nums">({money(comp.result.paye, comp.row.currency)})</td></tr>
                    {comp.result.otherDeductions.map((d, i) => <tr key={`od${i}`}><td className="td">− {d.label}{d.saving ? " (saving)" : ""}</td><td className="td text-right tabular-nums">({money(d.amount, comp.row.currency)})</td></tr>)}
                    <tr style={{ fontWeight: 700 }}><td className="td">Net pay</td><td className="td text-right tabular-nums">{money(comp.result.netPay, comp.row.currency)}</td></tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
          {comp.row.employmentType !== "consultant" && (
            <div className="card p-4 text-sm space-y-3">
              <div>
                <div className="label">Savings (not paid as cash)</div>
                <div className="flex justify-between"><span style={{ color: "var(--muted)" }}>Employer NSSF ({comp.config.nssfEmployerPct}%){comp.config.nssfEmployerFromFringe ? " · from fringe" : ""}</span><span className="tabular-nums">{money(comp.result.employerNSSF, comp.row.currency)}</span></div>
                <div className="flex justify-between"><span style={{ color: "var(--muted)" }}>Total NSSF saving</span><span className="tabular-nums">{money(comp.result.nssfSavings, comp.row.currency)}</span></div>
                {comp.result.otherSavings > 0 && <div className="flex justify-between"><span style={{ color: "var(--muted)" }}>Other savings (e.g. SACCO)</span><span className="tabular-nums">{money(comp.result.otherSavings, comp.row.currency)}</span></div>}
              </div>
              {comp.result.otherDeductionsTotal > 0 && (
                <div className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
                  <div className="label">Other deductions &amp; savings</div>
                  {comp.result.otherDeductions.map((d, i) => (
                    <div key={i} className="flex justify-between"><span style={{ color: "var(--muted)" }}>{d.label}{d.saving ? " (saving)" : ""}</span><span className="tabular-nums">{money(d.amount, comp.row.currency)}</span></div>
                  ))}
                  <div className="flex justify-between" style={{ fontWeight: 600 }}><span>Total</span><span className="tabular-nums">{money(comp.result.otherDeductionsTotal, comp.row.currency)}</span></div>
                </div>
              )}
              <div className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
                <div className="label">Fringe pool</div>
                <div className="flex justify-between"><span style={{ color: "var(--muted)" }}>Pool</span><span className="tabular-nums">{money(comp.result.fringePool, comp.row.currency)}</span></div>
                <div className="flex justify-between"><span style={{ color: "var(--muted)" }}>Used</span><span className="tabular-nums">{money(comp.result.fringeUsed, comp.row.currency)}</span></div>
                <div className="flex justify-between" style={{ color: comp.result.fringeOverspent > 0 ? "var(--danger)" : "var(--ok)" }}><span>{comp.result.fringeOverspent > 0 ? "Overspent" : "Unused"}</span><span className="tabular-nums">{money(comp.result.fringeOverspent > 0 ? comp.result.fringeOverspent : comp.result.fringeUnused, comp.row.currency)}</span></div>
              </div>
              <div className="pt-2 border-t" style={{ borderColor: "var(--border)" }}>
                <div className="label">Grant budgeting</div>
                <div className="flex justify-between"><span style={{ color: "var(--muted)" }}>Charged salary (base × {comp.row.effortPct}% effort)</span><span className="tabular-nums">{money(comp.result.chargedSalary, comp.row.currency)}</span></div>
                <div className="flex justify-between" style={{ fontWeight: 600 }}><span>Funds requested</span><span className="tabular-nums">{money(comp.result.fundsRequested, comp.row.currency)}</span></div>
              </div>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>No grant-model compensation set yet. Enter the gross actually paid (or base + % effort) and a fringe pool below; employee NSSF, PAYE and net pay are derived automatically. Employer NSSF is treated as a saving funded from the fringe pool — it never inflates gross or net.</p>
      )}
      <form action={upsertEmployeeCompAction} className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
        <input type="hidden" name="employeeId" value={e.id} />
        <Field label="Type"><select name="employmentType" defaultValue={comp?.row.employmentType ?? (e.contractType === "consultant" ? "consultant" : "staff")} className="select"><option value="staff">Staff (NSSF + PAYE)</option><option value="consultant">Consultant (withholding only)</option></select></Field>
        <Field label="Currency"><input name="currency" defaultValue={comp?.row.currency ?? e.currency} className="input" /></Field>
        <Field label="Charge to project"><select name="projectId" defaultValue={comp?.row.projectId ?? ""} className="select"><option value="">— none —</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select></Field>

        <Field label="Gross salary (staff)"><input type="number" step="0.01" name="grossSalary" defaultValue={comp?.row.grossSalary ?? ""} className="input" placeholder="entered directly" /></Field>
        <Field label="Base salary (for charging)"><input type="number" step="0.01" name="baseSalary" defaultValue={comp?.row.baseSalary ?? ""} className="input" placeholder="optional" /></Field>
        <Field label="% Effort"><input type="number" step="0.01" name="effortPct" defaultValue={comp?.row.effortPct ?? 100} className="input" /></Field>

        <Field label="Fringe amount"><input type="number" step="0.01" name="fringeAmount" defaultValue={comp?.row.fringeAmount ?? ""} className="input" placeholder="explicit pool" /></Field>
        <Field label="…or fringe rate %"><input type="number" step="0.01" name="fringeRatePct" defaultValue={comp?.row.fringeRatePct ?? ""} className="input" placeholder="e.g. 30" /></Field>
        <Field label="Fringe basis"><select name="fringeBasis" defaultValue={comp?.row.fringeBasis ?? "base"} className="select"><option value="base">Base salary</option><option value="charged">Charged salary</option></select></Field>

        <Field label="Requested funds (consultant)"><input type="number" step="0.01" name="requestedFunds" defaultValue={comp?.row.requestedFunds ?? ""} className="input" /></Field>
        <Field label="Cal. months"><input type="number" step="0.01" name="calMonths" defaultValue={comp?.row.calMonths ?? ""} className="input" /></Field>
        <Field label="PAYE rate % (override)"><input type="number" step="0.01" name="payeOverridePct" defaultValue={comp?.row.payeOverridePct ?? ""} className="input" placeholder="optional flat %" /></Field>

        <div className="sm:col-span-3">
          <div className="label">Other fringe benefits (drawn from the pool)</div>
          {[0, 1, 2].map((i) => {
            const b = comp?.benefits?.[i];
            return (
              <div key={i} className="grid grid-cols-2 gap-2 mb-2">
                <input name="benefitLabel" defaultValue={b?.label ?? ""} className="input" placeholder="e.g. Fuel, Airtime" />
                <input type="number" step="0.01" name="benefitAmount" defaultValue={b?.amount ?? ""} className="input" placeholder="amount" />
              </div>
            );
          })}
        </div>
        <div className="sm:col-span-3">
          <div className="label">Other deductions &amp; savings (e.g. SACCO, local service tax, insurance)</div>
          <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>Each reduces net take-home. Choose % of gross or a flat amount, and whether it's a saving (the employee's own money, e.g. SACCO) or a levy/tax.</p>
          {[0, 1, 2].map((i) => {
            const d = comp?.deductionDefs?.[i];
            return (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                <input name="deductionLabel" defaultValue={d?.label ?? ""} className="input" placeholder="e.g. SACCO" />
                <input type="number" step="0.01" name="deductionValue" defaultValue={d?.value ?? ""} className="input" placeholder="rate % or amount" />
                <select name="deductionKind" defaultValue={d?.kind ?? "pct_deduction"} className="select">
                  <option value="pct_saving">% of gross · saving</option>
                  <option value="pct_deduction">% of gross · deduction</option>
                  <option value="flat_saving">Flat amount · saving</option>
                  <option value="flat_deduction">Flat amount · deduction</option>
                </select>
              </div>
            );
          })}
        </div>
        <div className="sm:col-span-3"><Field label="Note"><input name="note" defaultValue={comp?.row.note ?? ""} className="input" /></Field></div>
        <div className="sm:col-span-3 flex items-center justify-between">
          <span className="text-xs" style={{ color: "var(--muted)" }}>PAYE method &amp; bands are set org-wide under HR → Compensation; the override above forces a flat PAYE % for this person (useful for non-UGX salaries).</span>
          <button className="btn btn-primary" type="submit">Save compensation</button>
        </div>
      </form>

      {/* project assignments — which projects this person works on, role & responsibilities */}
      <SectionTitle>Project assignments</SectionTitle>
      {sp.generated && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Generated {sp.generated} responsibilit{sp.generated === "1" ? "y" : "ies"} from the document — review and edit, then Save.</div>}
      {sp.generr === "type" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Please upload a Word .docx file.</div>}
      {sp.generr === "empty" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Couldn&apos;t find a responsibilities/duties list in that document. Add a heading like &quot;Responsibilities&quot; or bullet points, or type them manually.</div>}
      {sp.generr === "file" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Please choose a file to upload.</div>}
      {employeeProjects.length === 0 ? (
        <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>Not assigned to any project yet. Assign this person to one or more projects with a role and responsibilities below.</p>
      ) : (
        <div className="space-y-3 mb-3">
          {employeeProjects.map((a) => (
            <div key={a.id} className="card p-4">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div className="font-medium"><Link href={`/projects/${a.projectId}`} className="hover:underline" style={{ color: "var(--brand)" }}>{a.code}</Link> {a.title}</div>
                <form action={removeEmployeeProjectAction}>
                  <input type="hidden" name="employeeId" value={e.id} />
                  <input type="hidden" name="projectId" value={a.projectId} />
                  <input type="hidden" name="back" value={`/hr/employees/${e.id}`} />
                  <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Remove</button>
                </form>
              </div>
              <form action={upsertEmployeeProjectAction} className="grid sm:grid-cols-4 gap-3 items-start">
                <input type="hidden" name="employeeId" value={e.id} />
                <input type="hidden" name="projectId" value={a.projectId} />
                <input type="hidden" name="back" value={`/hr/employees/${e.id}`} />
                <Field label="Role"><input name="role" defaultValue={a.role ?? ""} className="input" placeholder="e.g. Data Manager" /></Field>
                <div className="sm:col-span-3"><Field label="Responsibilities"><textarea name="responsibilities" rows={5} defaultValue={a.responsibilities ?? ""} className="textarea" placeholder="One responsibility per line…" /></Field></div>
                <div className="sm:col-span-4 flex justify-end"><button className="btn btn-sm btn-primary" type="submit">Save</button></div>
              </form>
              <form action={generateResponsibilitiesFromDocAction} className="flex flex-wrap items-end gap-2 mt-3 pt-3 border-t" style={{ borderColor: "var(--border)" }}>
                <input type="hidden" name="employeeId" value={e.id} />
                <input type="hidden" name="projectId" value={a.projectId} />
                <input type="hidden" name="back" value={`/hr/employees/${e.id}`} />
                <Field label="…or generate them from a Word contract / ToR (.docx)"><input type="file" name="file" accept=".docx" className="input" /></Field>
                <button className="btn btn-sm" type="submit">Upload &amp; generate</button>
              </form>
            </div>
          ))}
        </div>
      )}
      {assignableProjects.length > 0 ? (
        <form action={upsertEmployeeProjectAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-start mb-6">
          <input type="hidden" name="employeeId" value={e.id} />
          <input type="hidden" name="back" value={`/hr/employees/${e.id}`} />
          <Field label="Project"><select name="projectId" required className="select"><option value="">— choose —</option>{assignableProjects.map((p) => <option key={p.id} value={p.id}>{p.code} {p.title}</option>)}</select></Field>
          <Field label="Role"><input name="role" className="input" placeholder="e.g. Data Manager" /></Field>
          <div className="sm:col-span-2"><Field label="Responsibilities"><textarea name="responsibilities" rows={2} className="textarea" placeholder="One per line — or add the assignment, then upload a contract to generate them" /></Field></div>
          <div className="sm:col-span-4 flex justify-end"><button className="btn btn-primary" type="submit">Assign to project</button></div>
        </form>
      ) : projects.length > 0 ? (
        <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>This person is assigned to all available projects.</p>
      ) : (
        <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>No projects exist yet to assign.</p>
      )}

      {/* documents — HR uploads (contracts) + employee-uploaded CV/certs */}
      <SectionTitle>Documents</SectionTitle>
      {sp.docuploaded && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Document uploaded.</div>}
      {sp.docdeleted && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Document deleted.</div>}
      {sp.docerr === "file" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Please choose a file.</div>}
      <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>Employee contracts and HR documents you upload here, together with the CV and certificates the employee uploads in their own portal. Visible to HR and admins only.</p>
      {empDocs.length === 0 ? <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>No documents yet.</p> : (
        <div className="card overflow-x-auto mb-3">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Document</th><th className="th text-left">Type</th><th className="th text-left">Uploaded</th><th className="th" /></tr></thead>
            <tbody>
              {empDocs.map((d) => (
                <tr key={d.id}>
                  <td className="td"><a href={`/api/employee-files/${d.id}`} className="hover:underline" style={{ color: "var(--brand)" }}>📎 {d.name}</a></td>
                  <td className="td"><Badge tone="muted">{label(d.docType)}</Badge></td>
                  <td className="td">{fmtDate(d.createdAt)}</td>
                  <td className="td text-right">
                    <form action={deleteEmployeeDocumentAction}>
                      <input type="hidden" name="documentId" value={d.id} />
                      <input type="hidden" name="employeeId" value={e.id} />
                      <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form action={uploadEmployeeDocumentAction} className="card p-4 flex flex-wrap items-end gap-3 mb-6">
        <input type="hidden" name="employeeId" value={e.id} />
        <Field label="Upload a document"><input type="file" name="file" required className="input" /></Field>
        <Field label="Type"><select name="docType" className="select"><option value="contract">Employee contract</option><option value="cv">CV / Résumé</option><option value="certificate">Certificate</option><option value="id">ID document</option><option value="other">Other</option></select></Field>
        <button className="btn btn-primary" type="submit">Upload</button>
      </form>

      {/* recent leave */}
      <SectionTitle>Recent leave</SectionTitle>
      {recentLeave.length === 0 ? <p className="text-sm mb-6" style={{ color: "var(--muted)" }}>No leave recorded.</p> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Type</th><th className="th text-left">From</th><th className="th text-left">To</th><th className="th text-right">Days</th><th className="th text-left">Status</th></tr></thead>
            <tbody>{recentLeave.map((l, i) => (
              <tr key={i}><td className="td">{label(l.leaveType)}</td><td className="td">{fmtDate(l.startDate)}</td><td className="td">{fmtDate(l.endDate)}</td><td className="td text-right">{l.days}</td><td className="td"><Badge tone={l.status === "approved" ? "ok" : l.status === "rejected" ? "danger" : "warn"}>{label(l.status)}</Badge></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}

      {/* edit */}
      <SectionTitle>Employment details</SectionTitle>
      <form action={updateEmployeeAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <input type="hidden" name="employeeId" value={e.id} />
        <Field label="Job title"><input name="jobTitle" defaultValue={e.jobTitle ?? ""} className="input" /></Field>
        <Field label="Department"><input name="department" defaultValue={e.department ?? ""} className="input" /></Field>
        <Field label="Contract type">
          <select name="contractType" defaultValue={e.contractType} className="select"><option value="permanent">Permanent</option><option value="fixed_term">Fixed term</option><option value="casual">Casual</option><option value="consultant">Consultant</option><option value="intern">Intern</option></select>
        </Field>
        <Field label="Basic salary"><input type="number" step="0.01" name="basicSalary" defaultValue={e.basicSalary} className="input" /></Field>
        <Field label="Currency"><input name="currency" defaultValue={e.currency} className="input" /></Field>
        <Field label="Status">
          <select name="status" defaultValue={e.status} className="select"><option value="active">Active</option><option value="on_leave">On leave</option><option value="terminated">Terminated</option></select>
        </Field>
        <Field label="Email"><input name="email" defaultValue={e.email ?? ""} className="input" /></Field>
        <Field label="Phone"><input name="phone" defaultValue={e.phone ?? ""} className="input" /></Field>
        <Field label="Annual leave (days)"><input type="number" step="0.5" name="annualLeaveDays" defaultValue={e.annualLeaveDays} className="input" /></Field>
        <Field label="Bank name"><input name="bankName" defaultValue={e.bankName ?? ""} className="input" /></Field>
        <Field label="Bank account"><input name="bankAccount" defaultValue={e.bankAccount ?? ""} className="input" /></Field>
        <Field label="Bank branch"><input name="bankBranch" defaultValue={e.bankBranch ?? ""} className="input" /></Field>
        <Field label="Mobile money"><input name="mobileMoney" defaultValue={e.mobileMoney ?? ""} className="input" /></Field>
        <Field label="Start date"><input type="date" name="startDate" defaultValue={dateInput(e.startDate)} className="input" /></Field>
        <Field label="End date"><input type="date" name="endDate" defaultValue={dateInput(e.endDate)} className="input" /></Field>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Save changes</button></div>
      </form>

      {/* Demographic & statutory details */}
      <SectionTitle>Personal & statutory details</SectionTitle>
      <form action={updateEmployeeProfileAction} className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
        <input type="hidden" name="employeeId" value={e.id} />
        <Field label="Prefix"><select name="prefix" defaultValue={demo.prefix ?? ""} className="select">{PREFIXES.map((p) => <option key={p} value={p}>{p || "—"}</option>)}</select></Field>
        <Field label="Gender"><select name="gender" defaultValue={demo.gender ?? ""} className="select"><option value="">—</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></Field>
        <Field label="Marital status"><select name="maritalStatus" defaultValue={demo.maritalStatus ?? ""} className="select"><option value="">—</option><option value="single">Single</option><option value="married">Married</option><option value="divorced">Divorced</option><option value="widowed">Widowed</option></select></Field>
        <Field label="Date of birth"><input type="date" name="dateOfBirth" defaultValue={dateInput(demo.dateOfBirth)} className="input" /></Field>
        <Field label="Nationality"><input name="nationality" defaultValue={demo.nationality ?? ""} className="input" /></Field>
        <Field label="National ID"><input name="nationalId" defaultValue={demo.nationalId ?? ""} className="input" /></Field>
        <Field label="NSSF number"><input name="nssfNumber" defaultValue={demo.nssfNumber ?? ""} className="input" /></Field>
        <Field label="TIN (tax) number"><input name="tinNumber" defaultValue={demo.tinNumber ?? ""} className="input" /></Field>
        <Field label="Phone"><input name="phone" defaultValue={e.phone ?? ""} className="input" /></Field>
        <Field label="Email"><input name="email" defaultValue={e.email ?? ""} className="input" /></Field>
        <div className="sm:col-span-3"><Field label="Residence / address"><input name="address" defaultValue={demo.address ?? ""} className="input" /></Field></div>
        <div className="sm:col-span-3 pt-2 mt-1 border-t" style={{ borderColor: "var(--border)" }}><div className="text-xs font-medium" style={{ color: "var(--muted)" }}>Next of kin</div></div>
        <Field label="Next of kin name"><input name="nextOfKin" defaultValue={demo.nextOfKin ?? ""} className="input" /></Field>
        <Field label="Relationship"><input name="nextOfKinRelationship" defaultValue={demo.nextOfKinRelationship ?? ""} className="input" /></Field>
        <Field label="NoK phone"><input name="nextOfKinPhone" defaultValue={demo.nextOfKinPhone ?? ""} className="input" /></Field>
        <div className="sm:col-span-3"><Field label="NoK address"><input name="nextOfKinAddress" defaultValue={demo.nextOfKinAddress ?? ""} className="input" /></Field></div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Save personal details</button></div>
      </form>

      {/* Education */}
      <SectionTitle>Education & qualifications</SectionTitle>
      {education.length > 0 && (
        <div className="card overflow-x-auto mb-3">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Type</th><th className="th text-left">Qualification</th><th className="th text-left">Institution</th><th className="th text-left">Year</th><th className="th" /></tr></thead>
            <tbody>{education.map((ed) => (
              <tr key={ed.id}><td className="td">{label(ed.kind)}</td><td className="td">{ed.qualification}</td><td className="td">{ed.institution ?? "—"}</td><td className="td">{ed.yearObtained ?? "—"}</td>
                <td className="td text-right"><form action={deleteEmployeeEducationAction}><input type="hidden" name="employeeId" value={e.id} /><input type="hidden" name="educationId" value={ed.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Remove</button></form></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <form action={addEmployeeEducationAction} className="card p-4 grid sm:grid-cols-5 gap-3 items-end mb-6">
        <input type="hidden" name="employeeId" value={e.id} />
        <Field label="Type"><select name="kind" className="select"><option value="degree">Degree</option><option value="certificate">Certificate</option><option value="fellowship">Fellowship</option><option value="training">Training</option><option value="other">Other</option></select></Field>
        <Field label="Qualification"><input name="qualification" required className="input" placeholder="PhD Epidemiology" /></Field>
        <Field label="Institution"><input name="institution" className="input" /></Field>
        <Field label="Year"><input name="yearObtained" className="input" placeholder="2019" /></Field>
        <button className="btn btn-primary" type="submit">Add</button>
      </form>

      {/* Policy / statutory numbers */}
      <SectionTitle>Other policy & registration numbers</SectionTitle>
      {policies.length > 0 && (
        <div className="card overflow-x-auto mb-3">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Label</th><th className="th text-left">Number</th><th className="th text-left">Note</th><th className="th" /></tr></thead>
            <tbody>{policies.map((pl) => (
              <tr key={pl.id}><td className="td">{pl.label}</td><td className="td font-mono text-xs">{pl.value}</td><td className="td">{pl.note ?? "—"}</td>
                <td className="td text-right"><form action={deleteEmployeePolicyAction}><input type="hidden" name="employeeId" value={e.id} /><input type="hidden" name="policyId" value={pl.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Remove</button></form></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      <form action={addEmployeePolicyAction} className="card p-4 grid sm:grid-cols-4 gap-3 items-end mb-6">
        <input type="hidden" name="employeeId" value={e.id} />
        <Field label="Label"><input name="label" required className="input" placeholder="Medical insurance" /></Field>
        <Field label="Number"><input name="value" required className="input" /></Field>
        <Field label="Note"><input name="note" className="input" /></Field>
        <button className="btn btn-primary" type="submit">Add</button>
      </form>

      {/* Termination / access revocation (needs PI approval) */}
      <SectionTitle>Termination & access</SectionTitle>
      {sp.hra === "requested" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Request submitted — it now needs PI approval before it takes effect.</div>}
      {sp.hra === "approved" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Approved and executed.</div>}
      {sp.hra === "rejected" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--muted)", borderColor: "var(--border)" }}>Request rejected.</div>}
      {sp.hra && !["requested", "approved", "rejected"].includes(sp.hra) && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>{decodeURIComponent(sp.hra)}</div>}

      {pendingAction ? (
        <div className="card p-4 mb-6" style={{ borderColor: "var(--warn)" }}>
          <div className="flex items-center gap-2 mb-2"><Badge tone="warn">Pending approval</Badge><span className="font-medium">{label(pendingAction.actionType)}</span></div>
          <p className="text-sm mb-1">Requested by {pendingAction.requestedByName ?? "—"}{pendingAction.reason ? ` — ${pendingAction.reason}` : ""}.</p>
          <p className="text-xs mb-3" style={{ color: "var(--muted)" }}>This action requires PI (or approver) sign-off. Approving it will take effect immediately{pendingAction.actionType === "terminate" ? " (employee terminated and login suspended)" : " (login suspended)"}.</p>
          <div className="flex gap-2">
            <form action={decideHrActionAction}><input type="hidden" name="requestId" value={pendingAction.id} /><input type="hidden" name="employeeId" value={e.id} /><button className="btn btn-sm btn-primary" name="decision" value="approved" type="submit">Approve &amp; execute</button></form>
            <form action={decideHrActionAction}><input type="hidden" name="requestId" value={pendingAction.id} /><input type="hidden" name="employeeId" value={e.id} /><button className="btn btn-sm" name="decision" value="rejected" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reject</button></form>
          </div>
        </div>
      ) : e.status !== "terminated" ? (
        <form action={requestHrActionAction} className="card p-4 mb-6 grid sm:grid-cols-4 gap-3 items-end">
          <input type="hidden" name="employeeId" value={e.id} />
          <Field label="Action"><select name="actionType" className="select"><option value="revoke_access">Revoke login access</option><option value="terminate">Terminate contract</option></select></Field>
          <div className="sm:col-span-2"><Field label="Reason"><input name="reason" className="input" /></Field></div>
          <Field label="Effective date"><input type="date" name="effectiveDate" className="input" /></Field>
          <div className="sm:col-span-4 flex items-center justify-between">
            <span className="text-xs" style={{ color: "var(--muted)" }}>Submits a request for PI approval — nothing happens until approved.</span>
            <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Request action</button>
          </div>
        </form>
      ) : (
        <div className="card p-4 mb-6"><Badge tone="muted">Terminated</Badge> <span className="text-sm" style={{ color: "var(--muted)" }}>This employee has been terminated.</span></div>
      )}
    </div>
  );
}
