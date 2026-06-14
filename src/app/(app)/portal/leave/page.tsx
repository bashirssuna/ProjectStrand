import { requirePortalEmployee } from "../_guard";
import { q } from "@/server/db";
import { leaveBalance } from "@/server/services/hr";
import { PageHeader, SectionTitle, Field, Badge, Empty, Stat } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { myRequestLeaveAction } from "@/app/actions";

export default async function MyLeave({ searchParams }: { searchParams: Promise<{ requested?: string; err?: string }> }) {
  const { employeeId } = await requirePortalEmployee();
  const sp = await searchParams;
  const lb = await leaveBalance(employeeId);
  const mine = await q<{ leaveType: string; startDate: string; endDate: string; days: number; status: string; reason: string | null }>(
    `SELECT leave_type AS "leaveType", start_date AS "startDate", end_date AS "endDate", days::float, status, reason FROM leave_request WHERE employee_id=$1 ORDER BY created_at DESC LIMIT 20`, [employeeId]
  );

  return (
    <div className="max-w-3xl">
      <PageHeader title="My leave" subtitle="Request leave and track your balance" />
      {sp.requested && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Leave request submitted for approval.</div>}
      {sp.err && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Enter valid dates and days.</div>}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Stat label="Entitlement" value={`${lb.entitlement}`} sub="days/year" />
        <Stat label="Taken" value={`${lb.taken}`} />
        <Stat label="Remaining" value={`${lb.remaining}`} tone="ok" />
      </div>

      <SectionTitle>Request leave</SectionTitle>
      <form action={myRequestLeaveAction} className="card p-4 grid sm:grid-cols-3 gap-3 mb-6">
        <Field label="Type"><select name="leaveType" className="select"><option value="annual">Annual</option><option value="sick">Sick</option><option value="unpaid">Unpaid</option><option value="maternity">Maternity</option><option value="other">Other</option></select></Field>
        <Field label="From"><input type="date" name="startDate" required className="input" /></Field>
        <Field label="To"><input type="date" name="endDate" required className="input" /></Field>
        <Field label="Days"><input type="number" step="0.5" name="days" required className="input" /></Field>
        <div className="sm:col-span-2"><Field label="Reason"><input name="reason" className="input" /></Field></div>
        <div className="sm:col-span-3 flex justify-end"><button className="btn btn-primary" type="submit">Submit request</button></div>
      </form>

      <SectionTitle>My requests</SectionTitle>
      {mine.length === 0 ? <Empty title="No leave requests yet" hint="Submit one above." /> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr><th className="th text-left">Type</th><th className="th text-left">From</th><th className="th text-left">To</th><th className="th text-right">Days</th><th className="th text-left">Status</th></tr></thead>
            <tbody>{mine.map((l, i) => (<tr key={i}><td className="td">{label(l.leaveType)}</td><td className="td">{fmtDate(l.startDate)}</td><td className="td">{fmtDate(l.endDate)}</td><td className="td text-right">{l.days}</td><td className="td"><Badge tone={l.status === "approved" ? "ok" : l.status === "rejected" ? "danger" : "warn"}>{label(l.status)}</Badge></td></tr>))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
