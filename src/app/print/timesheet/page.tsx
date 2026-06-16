import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one, q } from "@/server/db";
import { fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

function monthBounds(month: string): { start: string; next: string; title: string } {
  const m = /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
  const [y, mo] = m.split("-").map(Number);
  const start = `${m}-01`;
  const nd = new Date(Date.UTC(y, mo, 1)); // first of next month
  const next = nd.toISOString().slice(0, 10);
  const title = new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  return { start, next, title };
}

export default async function PrintTimesheet({ searchParams }: { searchParams: Promise<{ employeeId?: string; month?: string }> }) {
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const sp = await searchParams;
  const employeeId = sp.employeeId ?? "";
  const { start, next, title } = monthBounds(sp.month ?? "");

  const emp = await one<{ orgId: string; name: string; staffNo: string | null; jobTitle: string | null; department: string | null }>(
    `SELECT org_id AS "orgId", first_name || ' ' || last_name AS name, staff_no AS "staffNo", job_title AS "jobTitle", department
     FROM employee WHERE id=$1`, [employeeId]
  );
  if (!emp || emp.orgId !== org.id) redirect("/hr/timesheets");
  const rows = await q<{ workDate: string; project: string | null; hours: number; description: string | null; status: string; approvedBy: string | null }>(
    `SELECT t.work_date AS "workDate", p.code AS project, t.hours::float, t.description, t.status, t.approved_by_name AS "approvedBy"
     FROM timesheet t LEFT JOIN project p ON p.id=t.project_id
     WHERE t.employee_id=$1 AND t.work_date >= $2::date AND t.work_date < $3::date
     ORDER BY t.work_date`, [employeeId, start, next]
  );
  const total = rows.reduce((s, r) => s + r.hours, 0);
  const approvedHours = rows.filter((r) => r.status === "approved").reduce((s, r) => s + r.hours, 0);
  const lh = await getLetterhead(emp.orgId);
  const th: React.CSSProperties = { border: "1px solid #999", padding: "6px 9px", background: "#f5f5f5", textAlign: "left", fontSize: 12 };
  const td: React.CSSProperties = { border: "1px solid #999", padding: "6px 9px" };
  const tdR: React.CSSProperties = { ...td, textAlign: "right", whiteSpace: "nowrap" };

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 760, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <PrintLetterhead lh={lh} subtitle={`Monthly Timesheet · ${title}`} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontSize: 13 }}>
          <div>
            <div style={{ fontWeight: 600 }}>{emp.name}{emp.staffNo ? ` · ${emp.staffNo}` : ""}</div>
            {emp.jobTitle && <div style={{ color: "#444" }}>{emp.jobTitle}</div>}
            {emp.department && <div style={{ color: "#444" }}>{emp.department}</div>}
          </div>
          <div style={{ textAlign: "right" }}>
            <div>Period: {title}</div>
            <div>Total hours: <strong>{total}</strong></div>
            <div>Approved hours: {approvedHours}</div>
          </div>
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 18 }}>
          <thead><tr><th style={th}>Date</th><th style={th}>Project</th><th style={{ ...th, textAlign: "right" }}>Hours</th><th style={th}>Description</th><th style={th}>Status</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <tr><td style={td} colSpan={5}>No timesheet entries for this period.</td></tr>
              : rows.map((r, i) => (
                <tr key={i}><td style={td}>{fmtDate(r.workDate)}</td><td style={td}>{r.project ?? "—"}</td><td style={tdR}>{r.hours}</td><td style={td}>{r.description ?? "—"}</td><td style={td}>{label(r.status)}</td></tr>
              ))}
            <tr style={{ fontWeight: 700 }}><td style={td} colSpan={2}>Total</td><td style={tdR}>{total}</td><td style={td} colSpan={2} /></tr>
          </tbody>
        </table>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 48 }}>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12, color: "#555" }}>Employee signature &amp; date</div>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12, color: "#555" }}>Supervisor signature &amp; date</div>
        </div>
        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>Generated from Project Strand · {title}.</div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
