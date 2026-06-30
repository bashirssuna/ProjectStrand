import { getRecipientByToken, listPublicQuestions } from "@/server/services/surveys";
import { submitRecipientSurveyAction } from "@/app/actions";
import { SurveyForm } from "@/components/survey-form";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="light" style={{ minHeight: "100vh", background: "#eef2f7", color: "#0f1422" }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "40px 20px" }}>{children}</div>
    </div>
  );
}

export default async function RecipientSurveyPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ err?: string }> }) {
  const { token } = await params;
  const sp = await searchParams;
  const r = await getRecipientByToken(token);

  if (!r) return <Shell><div className="card p-6 text-center"><h1 style={{ fontSize: 20, fontWeight: 700 }}>Invalid link</h1><p style={{ color: "#475569", marginTop: 8, fontSize: 14 }}>This invitation link isn&apos;t recognised. Please check with your HR team.</p></div></Shell>;

  if (r.responded) {
    return <Shell><div className="card p-6 text-center"><div style={{ fontSize: 40 }}>✓</div><h1 style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>Thank you</h1><p style={{ color: "#475569", marginTop: 10, fontSize: 14 }}>Your response to <strong>{r.title}</strong> has been recorded. You don&apos;t need to do anything further.</p><div style={{ color: "#94a3b8", fontSize: 12, marginTop: 16 }}>{r.orgName}</div></div></Shell>;
  }

  if (r.status !== "open") {
    return <Shell><div className="card p-6 text-center"><h1 style={{ fontSize: 20, fontWeight: 700 }}>Survey unavailable</h1><p style={{ color: "#475569", marginTop: 8, fontSize: 14 }}>This survey is {r.status === "draft" ? "not open yet" : "closed"}. Please check with your HR team.</p></div></Shell>;
  }

  const questions = await listPublicQuestions(r.surveyId);
  return (
    <Shell>
      <div className="text-center mb-5">
        <div style={{ fontSize: 13, letterSpacing: 1, textTransform: "uppercase", color: "#64748b" }}>{r.orgName}</div>
        <h1 style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{r.title}</h1>
        {r.intro && <p style={{ color: "#475569", marginTop: 8, fontSize: 14 }}>{r.intro}</p>}
        {r.anonymous && <p style={{ color: "#64748b", marginTop: 6, fontSize: 13 }}>This survey is anonymous — your answers are not linked to you. Only whether you&apos;ve responded is tracked, so HR can follow up with those who haven&apos;t.</p>}
      </div>
      {sp.err === "closed" && <div className="card p-3 mb-4 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>This survey has just closed. Your response could not be recorded.</div>}
      <SurveyForm action={submitRecipientSurveyAction} tokenField="rtoken" tokenValue={token} anonymous={r.anonymous} questions={questions} />
    </Shell>
  );
}
