import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { employeeForUser } from "@/server/services/hr";
import { q, one } from "@/server/db";
import { fmtDate } from "@/lib/format";
import { getAppraisal, listItems, ratingLabel } from "@/server/services/appraisals";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";
import { AppraisalSignatures } from "@/components/appraisal-signatures";

export default async function PrintAppraisal({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org) redirect("/dashboard");
  const a = await getAppraisal(org.id, id);
  if (!a) redirect("/dashboard");
  const myEmp = await employeeForUser(user.id);
  const ok = org.isOrgAdmin || user.isSuperAdmin || (!!myEmp && (myEmp.id === a.employeeId || myEmp.id === a.appraiserEmployeeId));
  if (!ok) redirect("/dashboard");

  const [items, emp, edu, cyc] = await Promise.all([
    listItems(org.id, id),
    one<{ staffNo: string | null; contractType: string; startDate: string | null; email: string | null }>(
      `SELECT staff_no AS "staffNo", contract_type AS "contractType", start_date AS "startDate", email FROM employee WHERE id=$1`, [a.employeeId]),
    q<{ institution: string | null; year: string | null; qualification: string }>(
      `SELECT institution, year_obtained AS year, qualification FROM employee_education WHERE employee_id=$1 ORDER BY created_at`, [a.employeeId]),
    one<{ periodStart: string | null; periodEnd: string | null }>(`SELECT period_start AS "periodStart", period_end AS "periodEnd" FROM appraisal_cycle WHERE id=$1`, [a.cycleId]),
  ]);
  const objectives = items.filter((i) => i.kind === "objective");
  const competencies = items.filter((i) => i.kind === "competency");
  const lh = await getLetterhead(org.id);

  const td: React.CSSProperties = { border: "1px solid #999", padding: "5px 8px", fontSize: 12, verticalAlign: "top" };
  const th: React.CSSProperties = { ...td, background: "#f1f1f1", textAlign: "left", fontWeight: 600 };
  const hdr: React.CSSProperties = { background: "#222", color: "#fff", padding: "5px 10px", fontWeight: 700, fontSize: 13, marginTop: 20 };
  const row = (k: string, v: string | null) => (
    <div style={{ display: "flex", borderBottom: "1px dotted #bbb", padding: "3px 0", fontSize: 12.5 }}><div style={{ width: 230, color: "#444" }}>{k}</div><div style={{ fontWeight: 600 }}>{v || "—"}</div></div>
  );

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 820, margin: "0 auto", padding: "36px 30px" }}>
        <PrintLetterhead lh={lh} subtitle="STAFF ANNUAL APPRAISAL FORM" />
        <div style={{ textAlign: "center", fontSize: 12.5, margin: "6px 0 4px" }}>
          Appraisal period: {cyc?.periodStart ? fmtDate(cyc.periodStart) : "……"} &nbsp;to&nbsp; {cyc?.periodEnd ? fmtDate(cyc.periodEnd) : "……"} &nbsp;·&nbsp; {a.cycleName}
        </div>

        <div style={hdr}>SECTION A: PERSONAL INFORMATION</div>
        {row("Name of appraisee", a.employeeName)}
        {row("Designation", a.jobTitle)}
        {row("Department", a.department)}
        {row("Terms of employment", emp?.contractType ? emp.contractType.replace(/_/g, " ") : null)}
        {row("Date of appointment", emp?.startDate ? fmtDate(emp.startDate) : null)}
        {row("Staff number", emp?.staffNo ?? null)}
        {row("Name of appraiser", a.appraiserName)}

        <div style={hdr}>SECTION B: CONTINUOUS PROFESSIONAL DEVELOPMENT</div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
          <thead><tr><th style={{ ...th, width: 40 }}>No.</th><th style={th}>Institution</th><th style={{ ...th, width: 130 }}>Year</th><th style={{ ...th, width: 200 }}>Award / Qualification</th></tr></thead>
          <tbody>
            {(edu.length ? edu : [{ institution: "", year: "", qualification: "" }, { institution: "", year: "", qualification: "" }]).map((e, i) => (
              <tr key={i}><td style={td}>{i + 1}</td><td style={td}>{e.institution}</td><td style={td}>{e.year}</td><td style={td}>{e.qualification}</td></tr>
            ))}
          </tbody>
        </table>

        <div style={hdr}>SECTION C: JOB PERFORMANCE ACHIEVEMENTS</div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
          <thead><tr><th style={{ ...th, width: 30 }}>No.</th><th style={th}>Job assignment</th><th style={th}>Expected output / target</th><th style={{ ...th, width: 70 }}>By appraisee</th><th style={{ ...th, width: 70 }}>By appraiser</th><th style={th}>Remarks</th></tr></thead>
          <tbody>
            {objectives.length === 0 ? <tr><td style={td} colSpan={6}>—</td></tr> : objectives.map((o, i) => (
              <tr key={o.id}><td style={td}>{i + 1}</td><td style={td}>{o.title}</td><td style={td}>{o.target}</td><td style={{ ...td, textAlign: "center" }}>{o.selfRating ?? ""}</td><td style={{ ...td, textAlign: "center" }}>{o.managerRating ?? ""}</td><td style={td}>{o.managerComment}</td></tr>
            ))}
            <tr><td style={{ ...th, textAlign: "right" }} colSpan={4}>Average rating</td><td style={{ ...th, textAlign: "center" }}>{a.managerAvg ?? a.selfAvg ?? "—"}</td><td style={th}>{ratingLabel(a.managerAvg ?? a.selfAvg) ?? ""}</td></tr>
          </tbody>
        </table>
        <div style={{ fontSize: 10.5, color: "#555", marginTop: 4 }}>Rating scale — 5 Excellent · 4 Very good · 3 Good · 2 Fair · 1 Poor.</div>

        <div style={hdr}>SECTION D: ASSESSMENT OF CORE COMPETENCES</div>
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 6 }}>
          <thead><tr><th style={th}>Competence</th><th style={{ ...th, width: 70 }}>Rating</th><th style={th}>Comments</th></tr></thead>
          <tbody>
            {competencies.length === 0 ? <tr><td style={td} colSpan={3}>—</td></tr> : competencies.map((c) => (
              <tr key={c.id}><td style={td}>{c.title}</td><td style={{ ...td, textAlign: "center" }}>{c.managerRating ?? ""}</td><td style={td}>{c.managerComment}</td></tr>
            ))}
          </tbody>
        </table>

        <div style={hdr}>SECTION E: ACTION PLAN TO IMPROVE PERFORMANCE</div>
        <div style={{ border: "1px solid #999", padding: 10, minHeight: 50, fontSize: 12.5, whiteSpace: "pre-wrap", marginTop: 6 }}>{a.developmentPlan || "—"}</div>

        <div style={hdr}>SECTION G: COMMENTS, RECOMMENDATIONS & SIGNATURES</div>
        <div style={{ marginTop: 8, fontSize: 12.5 }}>
          <div style={{ marginBottom: 8 }}><b>Comments by the appraisee:</b><div style={{ border: "1px solid #ccc", padding: 8, minHeight: 34, whiteSpace: "pre-wrap" }}>{a.employeeComments || ""}</div></div>
          <div style={{ marginBottom: 8 }}><b>Comments by the appraiser:</b><div style={{ border: "1px solid #ccc", padding: 8, minHeight: 34, whiteSpace: "pre-wrap" }}>{a.managerComments || ""}</div></div>
          <div style={{ marginBottom: 12 }}><b>Recommendation by the Director, HR:</b><div style={{ border: "1px solid #ccc", padding: 8, minHeight: 34, whiteSpace: "pre-wrap" }}>{a.hrComments || ""}</div></div>
        </div>
        <AppraisalSignatures a={a} readOnly />

        <div style={{ marginTop: 24, textAlign: "center" }}><PrintButton /></div>
      </div>
    </div>
  );
}
