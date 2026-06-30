import { getOpenSurveyByToken, listPublicQuestions, parseOptions, SCALE_LABELS } from "@/server/services/surveys";
import { submitSurveyResponseAction } from "@/app/actions";

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

        <form action={submitSurveyResponseAction} className="card p-5 grid gap-5">
          <input type="hidden" name="token" value={token} />

          {!s.anonymous && (
            <div className="grid sm:grid-cols-2 gap-3">
              <div><label className="label">Your name (optional)</label><input name="respondentName" className="input" /></div>
              <div><label className="label">Department (optional)</label><input name="department" className="input" /></div>
            </div>
          )}

          {questions.length === 0 && <p style={{ color: "#64748b" }}>This survey has no questions yet.</p>}

          {questions.map((qn, i) => {
            const nm = `q_${qn.id}`;
            return (
              <div key={qn.id}>
                <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{i + 1}. {qn.prompt}{qn.required && <span style={{ color: "#dc2626" }}> *</span>}</div>

                {qn.type === "scale" && (
                  <div className="flex flex-wrap gap-2">
                    {SCALE_LABELS.map((lbl, idx) => (
                      <label key={idx} className="flex items-center gap-1 text-sm" style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}>
                        <input type="radio" name={nm} value={idx + 1} required={qn.required && idx === 0} /> {idx + 1} — {lbl}
                      </label>
                    ))}
                  </div>
                )}

                {qn.type === "rating" && (
                  <div className="flex gap-2">
                    {[1, 2, 3, 4, 5].map((v, idx) => (
                      <label key={v} className="flex items-center gap-1 text-sm" style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 14px", cursor: "pointer" }}>
                        <input type="radio" name={nm} value={v} required={qn.required && idx === 0} /> {v}
                      </label>
                    ))}
                  </div>
                )}

                {qn.type === "yes_no" && (
                  <div className="flex gap-2">
                    {[["1", "Yes"], ["0", "No"]].map(([val, lbl], idx) => (
                      <label key={val} className="flex items-center gap-1 text-sm" style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "6px 16px", cursor: "pointer" }}>
                        <input type="radio" name={nm} value={val} required={qn.required && idx === 0} /> {lbl}
                      </label>
                    ))}
                  </div>
                )}

                {qn.type === "single_choice" && (
                  <div className="grid gap-2">
                    {parseOptions(qn.options).map((opt, idx) => (
                      <label key={idx} className="flex items-center gap-2 text-sm" style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 12px", cursor: "pointer" }}>
                        <input type="radio" name={nm} value={opt} required={qn.required && idx === 0} /> {opt}
                      </label>
                    ))}
                  </div>
                )}

                {qn.type === "text" && <textarea name={nm} rows={3} required={qn.required} className="input" placeholder="Your answer" />}
              </div>
            );
          })}

          <div><button className="btn btn-primary" type="submit">Submit response</button></div>
          <p className="text-xs" style={{ color: "#64748b" }}>Please submit only once. Thank you for taking the time.</p>
        </form>
      </div>
    </div>
  );
}
