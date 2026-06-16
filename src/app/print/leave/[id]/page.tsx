import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { one } from "@/server/db";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

export default async function PrintLeave({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const r = await one<{
    orgId: string; emp: string; staffNo: string | null; jobTitle: string | null; department: string | null;
    leaveType: string; startDate: string; endDate: string; days: number; reason: string | null;
    status: string; decidedByName: string | null; decidedAt: string | null; decisionNote: string | null;
  }>(
    `SELECT lr.org_id AS "orgId", e.first_name || ' ' || e.last_name AS emp, e.staff_no AS "staffNo",
            e.job_title AS "jobTitle", e.department, lr.leave_type AS "leaveType", lr.start_date AS "startDate",
            lr.end_date AS "endDate", lr.days::float, lr.reason, lr.status,
            lr.decided_by_name AS "decidedByName", lr.decided_at AS "decidedAt", lr.decision_note AS "decisionNote"
     FROM leave_request lr JOIN employee e ON e.id=lr.employee_id WHERE lr.id=$1`, [id]
  );
  if (!r || r.orgId !== org.id) redirect("/dashboard");
  const lh = await getLetterhead(r.orgId);
  const td: React.CSSProperties = { border: "1px solid #999", padding: "7px 10px", width: 180, fontWeight: 600, background: "#f5f5f5" };
  const tv: React.CSSProperties = { border: "1px solid #999", padding: "7px 10px" };
  const decided = r.status === "approved" || r.status === "rejected";

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 660, margin: "0 auto", padding: "40px 32px", fontSize: 14 }}>
        <PrintLetterhead lh={lh} subtitle="Leave Application & Approval" />
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 18 }}>
          <tbody>
            <tr><td style={td}>Employee</td><td style={tv}>{r.emp}{r.staffNo ? ` · ${r.staffNo}` : ""}</td></tr>
            <tr><td style={td}>Job title</td><td style={tv}>{r.jobTitle ?? "—"}</td></tr>
            <tr><td style={td}>Department</td><td style={tv}>{r.department ?? "—"}</td></tr>
            <tr><td style={td}>Leave type</td><td style={tv}>{label(r.leaveType)}</td></tr>
            <tr><td style={td}>From</td><td style={tv}>{fmtDate(r.startDate)}</td></tr>
            <tr><td style={td}>To</td><td style={tv}>{fmtDate(r.endDate)}</td></tr>
            <tr><td style={td}>Working days</td><td style={{ ...tv, fontWeight: 700 }}>{r.days}</td></tr>
            <tr><td style={td}>Reason</td><td style={tv}>{r.reason ?? "—"}</td></tr>
            <tr><td style={td}>Status</td><td style={{ ...tv, fontWeight: 700, textTransform: "uppercase" }}>{label(r.status)}</td></tr>
            {decided && <tr><td style={td}>Decided by</td><td style={tv}>{r.decidedByName ?? "—"}{r.decidedAt ? ` · ${fmtDateTime(r.decidedAt)}` : ""}</td></tr>}
            {r.decisionNote && <tr><td style={td}>Decision note</td><td style={tv}>{r.decisionNote}</td></tr>}
          </tbody>
        </table>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, marginTop: 48 }}>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12, color: "#555" }}>Applicant signature &amp; date</div>
          <div style={{ borderTop: "1px solid #111", paddingTop: 6, fontSize: 12, color: "#555" }}>Approving officer signature &amp; date</div>
        </div>
        <div style={{ marginTop: 26, fontSize: 11, color: "#555", borderTop: "1px solid #999", paddingTop: 8 }}>Generated from Project Strand · {fmtDate(r.startDate)}–{fmtDate(r.endDate)}.</div>
        <div style={{ marginTop: 18 }} className="no-print"><PrintButton label="Print / Save as PDF" /></div>
      </div>
    </div>
  );
}
