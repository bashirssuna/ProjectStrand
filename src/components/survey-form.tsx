import { SCALE_LABELS, parseOptions, type Question } from "@/server/services/surveys";

export function SurveyForm({ action, tokenField, tokenValue, anonymous, questions }: {
  action: (formData: FormData) => void | Promise<void>;
  tokenField: string; tokenValue: string; anonymous: boolean; questions: Question[];
}) {
  return (
    <form action={action} className="card p-5 grid gap-5">
      <input type="hidden" name={tokenField} value={tokenValue} />

      {!anonymous && (
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
  );
}
