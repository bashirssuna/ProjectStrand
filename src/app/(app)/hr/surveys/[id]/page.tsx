import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHrOrg } from "../../_guard";
import { getSurvey, listQuestions, surveyResults, parseOptions, QUESTION_TYPES, typeLabel, SCALE_LABELS } from "@/server/services/surveys";
import { PageHeader, SectionTitle, Field, Stat, Badge, StatusBadge, Empty } from "@/components/ui";
import { label } from "@/lib/enums";
import { updateSurveyAction, setSurveyStatusAction, deleteSurveyAction, addSurveyQuestionAction, deleteSurveyQuestionAction, moveSurveyQuestionAction } from "@/app/actions";

const STATUSES = ["draft", "open", "closed"];

function DistBars({ dist, accent }: { dist: { label: string; count: number }[]; accent?: string }) {
  const max = Math.max(1, ...dist.map((d) => d.count));
  const total = dist.reduce((s, d) => s + d.count, 0);
  return (
    <div className="space-y-1 mt-2">
      {dist.map((d, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span style={{ width: 130, color: "var(--muted)" }} className="truncate text-right">{d.label}</span>
          <div className="flex-1 rounded" style={{ background: "var(--surface)", height: 16, position: "relative", overflow: "hidden" }}>
            <div style={{ width: `${(d.count / max) * 100}%`, height: "100%", background: accent ?? "var(--brand)", opacity: 0.8 }} />
          </div>
          <span style={{ width: 64 }} className="tabular-nums">{d.count}{total > 0 ? ` · ${Math.round((d.count / total) * 100)}%` : ""}</span>
        </div>
      ))}
    </div>
  );
}

export default async function SurveyDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const { id } = await params;
  const sp = await searchParams;
  const s = await getSurvey(orgId, id);
  if (!s) notFound();
  const [questions, results] = await Promise.all([listQuestions(orgId, id), surveyResults(orgId, id)]);
  const publicPath = `/survey/${s.token}`;
  const draft = s.status === "draft";

  return (
    <div className="max-w-4xl">
      <PageHeader title={s.title} subtitle={`Engagement survey · ${orgName}`} actions={<><a href={`/print/survey-results/${s.id}`} target="_blank" className="btn btn-sm">Print results ↗</a><Link href="/hr/surveys" className="btn btn-sm">← Surveys</Link></>} />
      {sp.err === "prompt" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A question prompt is required.</div>}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <StatusBadge status={s.status} />
        {s.anonymous ? <Badge tone="info">Anonymous</Badge> : <Badge tone="muted">Identified</Badge>}
        <span className="text-sm" style={{ color: "var(--muted)" }}>{s.responses} response{s.responses === 1 ? "" : "s"}</span>
        <div className="ml-auto flex items-center gap-2">
          <form action={setSurveyStatusAction} className="flex items-center gap-2">
            <input type="hidden" name="surveyId" value={s.id} />
            <select name="status" defaultValue={s.status} className="select select-sm">{STATUSES.map((x) => <option key={x} value={x}>{label(x)}</option>)}</select>
            <button className="btn btn-sm" type="submit">Set status</button>
          </form>
          <form action={deleteSurveyAction}><input type="hidden" name="surveyId" value={s.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }}>Delete</button></form>
        </div>
      </div>

      {s.status === "open" ? (
        <div className="card p-3 mb-5 text-sm flex flex-wrap items-center gap-2" style={{ background: "color-mix(in srgb, var(--ok) 8%, transparent)" }}>
          <Badge tone="ok">Live</Badge>
          <span style={{ color: "var(--muted)" }}>Share this link with staff:</span>
          <code style={{ fontWeight: 600 }}>{publicPath}</code>
          <Link href={publicPath} target="_blank" className="btn btn-sm ml-auto">Open survey ↗</Link>
        </div>
      ) : draft ? (
        <div className="card p-3 mb-5 text-sm" style={{ color: "var(--muted)" }}>Add your questions, then set the status to <strong>Open</strong> to publish the staff link. {questions.length === 0 && "Add at least one question first."}</div>
      ) : (
        <div className="card p-3 mb-5 text-sm" style={{ color: "var(--muted)" }}>This survey is closed. Responses are final; results are below.</div>
      )}

      {/* Questions builder */}
      <SectionTitle>Questions</SectionTitle>
      <div className="mt-2 mb-4">
        {questions.length === 0 ? <Empty title="No questions yet" hint="Add questions below." /> : (
          <div className="space-y-2">
            {questions.map((qn, i) => (
              <div key={qn.id} className="card p-3 flex items-start gap-3">
                <span className="text-xs tabular-nums mt-1" style={{ color: "var(--muted)" }}>{i + 1}.</span>
                <div className="flex-1">
                  <div className="font-medium text-sm">{qn.prompt}{qn.required && <span style={{ color: "var(--danger)" }}> *</span>}</div>
                  <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>{typeLabel(qn.type)}{qn.type === "single_choice" && parseOptions(qn.options).length ? ` — ${parseOptions(qn.options).join(", ")}` : ""}</div>
                </div>
                {draft && (
                  <div className="flex items-center gap-1">
                    <form action={moveSurveyQuestionAction}><input type="hidden" name="surveyId" value={s.id} /><input type="hidden" name="questionId" value={qn.id} /><input type="hidden" name="dir" value="up" /><button className="btn btn-sm" type="submit" title="Move up" disabled={i === 0}>↑</button></form>
                    <form action={moveSurveyQuestionAction}><input type="hidden" name="surveyId" value={s.id} /><input type="hidden" name="questionId" value={qn.id} /><input type="hidden" name="dir" value="down" /><button className="btn btn-sm" type="submit" title="Move down" disabled={i === questions.length - 1}>↓</button></form>
                    <form action={deleteSurveyQuestionAction}><input type="hidden" name="surveyId" value={s.id} /><input type="hidden" name="questionId" value={qn.id} /><button className="btn btn-sm" type="submit" style={{ color: "var(--danger)" }} title="Remove">✕</button></form>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {draft && (
        <div className="card p-4 mb-6">
          <SectionTitle>Add question</SectionTitle>
          <form action={addSurveyQuestionAction} className="grid sm:grid-cols-2 gap-3 mt-2">
            <input type="hidden" name="surveyId" value={s.id} />
            <div className="sm:col-span-2"><Field label="Prompt *"><input name="prompt" required className="input input-sm" placeholder="e.g. I feel valued for the work I do." /></Field></div>
            <Field label="Type"><select name="type" className="select select-sm">{QUESTION_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}</select></Field>
            <label className="flex items-center gap-2 text-sm self-end"><input type="checkbox" name="required" defaultChecked /> Required</label>
            <div className="sm:col-span-2"><Field label="Options (multiple choice only — one per line)"><textarea name="options" rows={3} className="input input-sm" placeholder={"Yes\nNo\nNot sure"} /></Field></div>
            <div className="sm:col-span-2"><button className="btn btn-sm btn-primary" type="submit">Add question</button></div>
          </form>
        </div>
      )}

      {/* Results */}
      <SectionTitle>Results</SectionTitle>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-2 mb-4">
        <Stat label="Responses" value={String(results.responses)} />
        <Stat label="Engagement score" value={results.engagementScore != null ? `${results.engagementScore}%` : "—"} tone={results.engagementScore != null ? (results.engagementScore >= 70 ? "ok" : results.engagementScore >= 50 ? "warn" : "danger") : undefined} sub={results.scaleQuestions > 0 ? `from ${results.scaleQuestions} scale question${results.scaleQuestions === 1 ? "" : "s"}` : undefined} />
        <Stat label="Questions" value={String(questions.length)} />
      </div>

      {results.responses === 0 ? <Empty title="No responses yet" hint={s.status === "open" ? "Results appear as staff respond." : "Open the survey to collect responses."} /> : (
        <div className="space-y-4">
          {results.questions.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="font-medium text-sm">{r.prompt}</div>
                <div className="text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>{r.answered} answered</div>
              </div>
              {(r.type === "scale" || r.type === "rating") && (
                <>
                  <div className="text-2xl font-semibold mt-1">{r.average != null ? r.average.toFixed(2) : "—"}<span className="text-sm font-normal" style={{ color: "var(--muted)" }}> / 5 average</span></div>
                  <DistBars dist={r.distribution} />
                </>
              )}
              {r.type === "yes_no" && <DistBars dist={r.distribution} accent="var(--ok)" />}
              {r.type === "single_choice" && <DistBars dist={r.distribution} />}
              {r.type === "text" && (
                r.texts.length === 0 ? <p className="text-sm mt-2" style={{ color: "var(--muted)" }}>No free-text answers.</p> : (
                  <div className="mt-2 space-y-1 max-h-72 overflow-y-auto">
                    {r.texts.map((t, i) => <div key={i} className="text-sm p-2 rounded" style={{ background: "var(--surface)" }}>&ldquo;{t}&rdquo;</div>)}
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}

      {/* Settings */}
      <details className="card p-4 mt-6">
        <summary className="text-sm font-medium cursor-pointer">Survey settings</summary>
        <form action={updateSurveyAction} className="grid gap-3 mt-3">
          <input type="hidden" name="surveyId" value={s.id} />
          <Field label="Title"><input name="title" defaultValue={s.title} className="input input-sm" /></Field>
          <Field label="Description (internal)"><input name="description" defaultValue={s.description ?? ""} className="input input-sm" /></Field>
          <Field label="Intro shown to respondents"><textarea name="intro" rows={2} defaultValue={s.intro ?? ""} className="input input-sm" /></Field>
          <Field label="Thank-you message"><input name="thankYou" defaultValue={s.thankYou ?? ""} className="input input-sm" /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="anonymous" defaultChecked={s.anonymous} /> Anonymous</label>
          <div><button className="btn btn-sm btn-primary" type="submit">Save settings</button></div>
        </form>
      </details>
    </div>
  );
}
