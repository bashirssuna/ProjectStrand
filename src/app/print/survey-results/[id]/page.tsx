import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth";
import { getUserOrg } from "@/server/services/accounts";
import { getSurvey, surveyResults } from "@/server/services/surveys";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead, getLetterhead } from "@/components/letterhead";

export default async function PrintSurveyResults({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const org = await getUserOrg(user.id);
  if (!org || (!org.isOrgAdmin && !user.isSuperAdmin)) redirect("/dashboard");
  const s = await getSurvey(org.id, id);
  if (!s) redirect("/dashboard");
  const [results, lh] = await Promise.all([surveyResults(org.id, id), getLetterhead(org.id)]);

  return (
    <div className="light" style={{ background: "#fff", color: "#111", minHeight: "100vh" }}>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: 32 }}>
        <div className="no-print" style={{ marginBottom: 12, textAlign: "right" }}><PrintButton /></div>
        <PrintLetterhead lh={lh} subtitle="Staff Engagement Survey — Results" />

        <h2 style={{ fontSize: 16, fontWeight: 700, margin: "8px 0" }}>{s.title}</h2>
        <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
          <Box label="Responses" value={String(results.responses)} />
          <Box label="Engagement score" value={results.engagementScore != null ? `${results.engagementScore}%` : "—"} />
          <Box label="Questions" value={String(results.questions.length)} />
        </div>

        {results.responses === 0 ? <p style={{ color: "#777" }}>No responses recorded.</p> : results.questions.map((r, qi) => (
          <div key={r.id} style={{ marginBottom: 18, breakInside: "avoid" }}>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{qi + 1}. {r.prompt}</div>
            <div style={{ fontSize: 11, color: "#666", margin: "2px 0 6px" }}>{r.answered} answered{(r.type === "scale" || r.type === "rating") && r.average != null ? ` · average ${r.average.toFixed(2)} / 5` : ""}</div>
            {(r.type === "scale" || r.type === "rating" || r.type === "yes_no" || r.type === "single_choice") && (
              <table style={{ width: "100%", fontSize: 11, borderCollapse: "collapse" }}>
                <tbody>
                  {r.distribution.map((d, i) => {
                    const total = r.distribution.reduce((s2, x) => s2 + x.count, 0) || 1;
                    return (
                      <tr key={i} style={{ borderBottom: "1px solid #eee" }}>
                        <td style={{ padding: "3px 6px", width: 220 }}>{d.label}</td>
                        <td style={{ padding: "3px 6px", width: 60, textAlign: "right" }}>{d.count}</td>
                        <td style={{ padding: "3px 6px", width: 50, textAlign: "right", color: "#666" }}>{Math.round((d.count / total) * 100)}%</td>
                        <td style={{ padding: "3px 6px" }}><div style={{ height: 9, width: `${(d.count / total) * 100}%`, background: "#475569" }} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            {r.type === "text" && (
              r.texts.length === 0 ? <div style={{ fontSize: 11, color: "#777" }}>No free-text answers.</div> : (
                <ul style={{ fontSize: 11, margin: "4px 0 0 16px" }}>{r.texts.map((t, i) => <li key={i} style={{ marginBottom: 2 }}>&ldquo;{t}&rdquo;</li>)}</ul>
              )
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function Box({ label, value }: { label: string; value: string }) {
  return <div style={{ flex: 1, border: "1px solid #ccc", borderRadius: 6, padding: "8px 12px" }}><div style={{ fontSize: 11, color: "#666" }}>{label}</div><div style={{ fontSize: 15, fontWeight: 700 }}>{value}</div></div>;
}
