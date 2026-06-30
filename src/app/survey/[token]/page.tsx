import { getOpenSurveyByToken, listPublicQuestions } from "@/server/services/surveys";
import { submitSurveyResponseAction } from "@/app/actions";
import { SurveyForm } from "@/components/survey-form";

export default async function SurveyRespondPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ err?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const s = await getOpenSurveyByToken(token);

  if (!s) {
    return (
      <div className="light" style={{ minHeight: "100vh", background: "#eef2f7", color: "#0f1422" }}>
        <div style={{ maxWidth: 560, margin: "0 auto", padding: "80px 20px", textAlign: "center" }}>
          <div className="card p-6">
            <h1 style={{ fontSize: 20, fontWeight: 700 }}>Survey unavailable</h1>
            <p style={{ color: "#475569", marginTop: 8, fontSize: 14 }}>This survey is closed or the link is invalid. Please check with your HR team.</p>
          </div>
        </div>
      </div>
    );
  }
  const questions = await listPublicQuestions(s.id);

  return (
    <div className="light" style={{ minHeight: "100vh", background: "#eef2f7", color: "#0f1422" }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "40px 20px" }}>
        <div className="text-center mb-5">
          <div style={{ fontSize: 13, letterSpacing: 1, textTransform: "uppercase", color: "#64748b" }}>{s.orgName}</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{s.title}</h1>
          {s.intro && <p style={{ color: "#475569", marginTop: 8, fontSize: 14 }}>{s.intro}</p>}
          {s.anonymous && <p style={{ color: "#64748b", marginTop: 6, fontSize: 13 }}>This survey is anonymous — your responses are not linked to your identity.</p>}
        </div>

        {sp.err === "closed" && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>This survey has just closed. Your response could not be recorded.</div>}

        <SurveyForm action={submitSurveyResponseAction} tokenField="token" tokenValue={token} anonymous={s.anonymous} questions={questions} />
      </div>
    </div>
  );
}
