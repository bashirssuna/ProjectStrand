import Link from "next/link";
import { notFound } from "next/navigation";
import { requireHrOrg } from "../../_guard";
import { getSurvey, listQuestions, surveyResults, parseOptions, QUESTION_TYPES, typeLabel, SCALE_LABELS, listRecipients, recipientStats } from "@/server/services/surveys";
import { q } from "@/server/db";
import { PageHeader, SectionTitle, Field, Stat, Badge, StatusBadge, Empty, ProgressBar } from "@/components/ui";
import { label } from "@/lib/enums";
import { updateSurveyAction, setSurveyStatusAction, deleteSurveyAction, addSurveyQuestionAction, deleteSurveyQuestionAction, moveSurveyQuestionAction, addSurveyRecipientsAction, removeSurveyRecipientAction, markSurveyRecipientsSentAction } from "@/app/actions";

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

export default async function SurveyDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ err?: string; added?: string; sent?: string; failed?: string; skipped?: string; opened?: string }> }) {
  const { orgId, orgName } = await requireHrOrg();
  const { id } = await params;
  const sp = await searchParams;
  const s = await getSurvey(orgId, id);
  if (!s) notFound();
  const [questions, results, recipients, recStats, departments, projects, employees] = await Promise.all([
    listQuestions(orgId, id), surveyResults(orgId, id), listRecipients(orgId, id), recipientStats(orgId, id),
    q<{ name: string }>(`SELECT name FROM department WHERE org_id=$1 ORDER BY name`, [orgId]),
    q<{ id: string; code: string; title: string }>(`SELECT id, code, title FROM project WHERE org_id=$1 ORDER BY code`, [orgId]),
    q<{ id: string; name: string; department: string | null }>(`SELECT id, (first_name || ' ' || last_name) AS name, department FROM employee WHERE org_id=$1 AND status <> 'terminated' ORDER BY first_name, last_name`, [orgId]),
  ]);
  const publicPath = `/survey/${s.token}`;
  const draft = s.status === "draft";

  return (
    <div className="max-w-4xl">
      <PageHeader title={s.title} subtitle={`Engagement survey · ${orgName}`} actions={<><a href={`/print/survey-results/${s.id}`} target="_blank" className="btn btn-sm">Print results ↗</a><Link href="/hr/surveys" className="btn btn-sm">← Surveys</Link></>} />
      {sp.err === "prompt" && <div className="card p-3 mb-3 text-sm" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>A question prompt is required.</div>}
      {sp.sent !== undefined && (
        <div className="card p-3 mb-3 text-sm" style={{ color: Number(sp.failed) > 0 ? "var(--warn)" : "var(--ok)", borderColor: Number(sp.failed) > 0 ? "var(--warn)" : "var(--ok)" }}>
          {sp.opened === "1" && "Survey opened. "}
          Emailed {sp.sent} invitation{sp.sent === "1" ? "" : "s"}
          {Number(sp.failed) > 0 ? `, ${sp.failed} failed to send` : ""}
          {Number(sp.skipped) > 0 ? `, ${sp.skipped} recipient${sp.skipped === "1" ? " has" : "s have"} no email` : ""}.
          {process.env.EMAIL_PROVIDER === "console" && " (Email provider is set to console — invitations are logged, not delivered. Configure SMTP/Resend to send for real.)"}
        </div>
      )}

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
        <div className="card p-3 mb-5 text-sm" style={{ color: "var(--muted)" }}>Add your questions and target recipients below, then set the status to <strong>Open</strong> — this publishes the staff link and emails every targeted employee their unique survey link. {questions.length === 0 && "Add at least one question first."}</div>
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

      {/* Distribution */}
      <SectionTitle>Distribution</SectionTitle>
      {sp.added && <div className="card p-3 my-2 text-sm" style={{ color: "var(--ok)", borderColor: "var(--ok)" }}>Added {sp.added} recipient{sp.added === "1" ? "" : "s"}.</div>}
      <p className="text-xs mt-1 mb-3" style={{ color: "var(--muted)" }}>
        Send the survey to specific staff — by department, project team, or named individuals. Each person gets a private link; {s.anonymous ? "their answers stay anonymous, only whether they've responded is tracked" : "responses may be linked to them"}.
        When you <strong>Open</strong> the survey (or click <strong>Email invitations</strong>), each targeted employee is emailed their unique link at the address on their staff record. You can also <strong>export the list</strong> for your own mail-merge.
      </p>

      {recStats.total > 0 && (
        <div className="card p-3 mb-3">
          <div className="flex justify-between text-xs mb-1"><span style={{ color: "var(--muted)" }}>Response rate</span><span>{recStats.responded} of {recStats.total} responded · {recStats.rate}%</span></div>
          <ProgressBar value={recStats.rate} />
        </div>
      )}

      <div className="grid sm:grid-cols-3 gap-3 mb-3">
        <form action={addSurveyRecipientsAction} className="card p-3 flex flex-col gap-2">
          <input type="hidden" name="surveyId" value={s.id} /><input type="hidden" name="mode" value="department" />
          <div className="text-xs font-medium">By department</div>
          <select name="department" className="select select-sm" required disabled={departments.length === 0}>{departments.length === 0 ? <option value="">No departments</option> : departments.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}</select>
          <button className="btn btn-sm" type="submit" disabled={departments.length === 0}>Add department</button>
        </form>
        <form action={addSurveyRecipientsAction} className="card p-3 flex flex-col gap-2">
          <input type="hidden" name="surveyId" value={s.id} /><input type="hidden" name="mode" value="project" />
          <div className="text-xs font-medium">By project team</div>
          <select name="projectId" className="select select-sm" required disabled={projects.length === 0}>{projects.length === 0 ? <option value="">No projects</option> : projects.map((p) => <option key={p.id} value={p.id}>{p.code} — {p.title}</option>)}</select>
          <button className="btn btn-sm" type="submit" disabled={projects.length === 0}>Add team</button>
        </form>
        <form action={addSurveyRecipientsAction} className="card p-3 flex flex-col gap-2">
          <input type="hidden" name="surveyId" value={s.id} /><input type="hidden" name="mode" value="individuals" />
          <div className="text-xs font-medium">Individuals <span style={{ color: "var(--muted)" }}>(ctrl/⌘-click)</span></div>
          <select name="employeeIds" multiple className="select select-sm" style={{ minHeight: 90 }} disabled={employees.length === 0}>{employees.map((e) => <option key={e.id} value={e.id}>{e.name}{e.department ? ` · ${e.department}` : ""}</option>)}</select>
          <button className="btn btn-sm" type="submit" disabled={employees.length === 0}>Add selected</button>
        </form>
      </div>

      <div className="mb-6">
        {recipients.length === 0 ? <Empty title="No recipients yet" hint="Add staff above, or just share the open link when the survey is live." /> : (
          <>
            <div className="flex items-center gap-2 mb-2">
              <form action={markSurveyRecipientsSentAction}><input type="hidden" name="surveyId" value={s.id} /><button className="btn btn-sm btn-primary" type="submit">✉ Email invitations</button></form>
              <a href={`/api/survey-recipients/${s.id}`} className="btn btn-sm">Export links (CSV)</a>
              <span className="text-xs" style={{ color: "var(--muted)" }}>{recipients.length} recipient{recipients.length === 1 ? "" : "s"} · each gets a unique link at their email</span>
            </div>
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr><th className="th text-left">Name</th><th className="th text-left">Dept / email</th><th className="th text-left">Source</th><th className="th text-left">Status</th><th className="th text-left">Invite link</th><th className="th" /></tr></thead>
                <tbody>
                  {recipients.map((r) => (
                    <tr key={r.id}>
                      <td className="td font-medium">{r.name ?? "—"}</td>
                      <td className="td">{[r.department, r.email].filter(Boolean).join(" · ") || "—"}</td>
                      <td className="td">{r.source ? label(r.source) : "—"}</td>
                      <td className="td">{r.responded ? <Badge tone="ok">Responded</Badge> : r.sent ? <Badge tone="info">Sent</Badge> : <Badge tone="muted">Pending</Badge>}</td>
                      <td className="td"><a href={`/survey/r/${r.token}`} target="_blank" className="hover:underline" style={{ color: "var(--brand)" }}>/survey/r/{r.token.slice(0, 8)}… ↗</a></td>
                      <td className="td text-right"><form action={removeSurveyRecipientAction}><input type="hidden" name="surveyId" value={s.id} /><input type="hidden" name="recipientId" value={r.id} /><button className="btn btn-sm" type="submit" title="Remove">✕</button></form></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

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
