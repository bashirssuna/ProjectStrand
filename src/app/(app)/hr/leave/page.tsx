import Link from "next/link";
import { requireHrOrg } from "../_guard";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Badge, Empty } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { requestLeaveAction, decideLeaveAction } from "@/app/actions";

export default async function LeavePage({ searchParams }: { searchParams: Promise<{ requested?: string; decided?: string; err?: string }> }) {
  const { orgId } = await requireHrOrg();
  const sp = await searchParams;
  const employees = await q<{ id: string; firstName: string; lastName: string }>(`SELECT id, first_name AS "firstName", last_name AS "lastName" FROM employee WHERE org_id=$1 AND status<>'terminated' ORDER BY last_name`, [orgId]);
  const requests = await q<{ id: string; emp: string; leaveType: string; startDate: string; endDate: string; days: number; status: string; reason: string | null; decidedByName: string | null; decisionNote: string | null }>(
    `SELECT lr.id, e.first_name || ' ' || e.last_name AS emp, lr.leave_type AS "leaveType",
            lr.start_date AS "startDate", lr.end_date AS "endDate", lr.days::float, lr.status, lr.reason,
            lr.decided_by_name AS "decidedByName", lr.decision_note AS "decisionNote"
     FROM leave_request lr JOIN employee e ON e.id=lr.employee_id WHERE lr.org_id=$1 ORDER BY lr.created_at DESC LIMIT 50`, [orgId]
  );

  return (
    <div className="max-w-4xl">
      <PageHeader title="Leave" subtitle="Requests, approvals and balances" actions={<Link href="/hr" className="btn btn-sm">← HR</Link>} />
      {sp.requested && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Leave request submitted.</div>}
      {sp.decided && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Decision recorded.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter dates and a positive number of days.</div>}

      <SectionTitle>Requests</SectionTitle>
      {requests.length === 0 ? <Empty title="No leave requests" hint="Submit one below." /> : (
        <div className="card overflow-x-auto mb-6">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Employee</th><th className="th text-left">Type</th><th className="th text-left">From</th><th className="th text-left">To</th><th className="th text-right">Days</th><th className="th text-left">Status</th><th className="th" /></tr></thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td className="td">{r.emp}</td>
                  <td className="td">{label(r.leaveType)}</td>
                  <td className="td whitespace-nowrap">{fmtDate(r.startDate)}</td>
                  <td className="td whitespace-nowrap">{fmtDate(r.endDate)}</td>
                  <td className="td text-right">{r.days}</td>
                  <td className="td"><Badge tone={r.status === "approved" ? "ok" : r.status === "rejected" ? "danger" : "warn"}>{label(r.status)}</Badge>
                    {r.status !== "pending" && r.decidedByName && <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>by {r.decidedByName}{r.decisionNote ? ` — ${r.decisionNote}` : ""}</div>}
                  </td>
                  <td className="td text-right whitespace-nowrap">
                    <div className="flex gap-1 justify-end items-center">
                      {r.status === "pending" && (
                        <form action={decideLeaveAction} className="flex gap-1 items-center">
                          <input type="hidden" name="leaveId" value={r.id} />
                          <input name="decisionNote" placeholder="Note (optional)" className="input" style={{ height: 30, padding: "2px 8px", width: 130 }} />
                          <button className="btn btn-sm btn-primary" name="decision" value="approved" type="submit">Approve</button>
                          <button className="btn btn-sm" name="decision" value="rejected" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Reject</button>
                        </form>
                      )}
                      <a href={`/print/leave/${r.id}`} target="_blank" rel="noopener" className="btn btn-sm" title="Print / Save as PDF">🖨</a>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SectionTitle>Submit a leave request</SectionTitle>
      <form action={requestLeaveAction} className="card p-4 grid sm:grid-cols-3 gap-3">
        <Field label="Employee">
          <select name="employeeId" required className="select"><option value="">— choose —</option>{employees.map((e) => <option key={e.id} value={e.id}>{e.firstName} {e.lastName}</option>)}</select>
        </Field>
        <Field label="Type">
          <select name="leaveType" className="select"><option value="annual">Annual</option><option value="sick">Sick</option><option value="unpaid">Unpaid</option><option value="maternity">Maternity</option><option value="other">Other</option></select>
        </Field>
        <Field label="Days"><input type="number" step="0.5" name="days" required className="input" /></Field>
        <Field label="From"><input type="date" name="startDate" required className="input" /></Field>
        <Field label="To"><input type="date" name="endDate" required className="input" /></Field>
        <Field label="Reason"><input name="reason" className="input" /></Field>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Submit request</button></div>
      </form>
    </div>
  );
}
