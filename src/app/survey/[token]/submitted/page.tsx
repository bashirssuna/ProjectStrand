import { one } from "@/server/db";

export default async function SurveySubmittedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const s = await one<{ title: string; thankYou: string | null; orgName: string }>(
    `SELECT s.title, s.thank_you AS "thankYou", o.name AS "orgName" FROM survey s JOIN organization o ON o.id=s.org_id WHERE s.token=$1`, [token]);

  return (
    <div className="light" style={{ minHeight: "100vh", background: "#eef2f7", color: "#0f1422" }}>
      <div style={{ maxWidth: 540, margin: "0 auto", padding: "80px 20px", textAlign: "center" }}>
        <div className="card p-6">
          <div style={{ fontSize: 40 }}>✓</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>Response submitted</h1>
          <p style={{ color: "#475569", marginTop: 10, fontSize: 14 }}>{s?.thankYou || "Thank you for your feedback. Your response has been recorded."}</p>
          {s && <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 16 }}>{s.orgName} · {s.title}</div>}
        </div>
      </div>
    </div>
  );
}
