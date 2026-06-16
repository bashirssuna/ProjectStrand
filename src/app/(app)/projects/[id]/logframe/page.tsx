import Link from "next/link";
import { q, one } from "@/server/db";
import { getProjectAccess } from "@/server/policy";
import { SectionTitle, Empty, ProgressBar, Badge, Field } from "@/components/ui";
import { num, money, fmtDate } from "@/lib/format";
import { label } from "@/lib/enums";
import { addObjectiveAction, deleteObjectiveAction, addIndicatorAction, deleteIndicatorAction, uploadObjectivesAction, linkActivityToOutputAction, updateObjectiveAction, updateIndicatorAction, recordIndicatorActualAction, deleteIndicatorActualAction } from "@/app/actions";

export default async function LogframePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ view?: string; imported?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  const view = sp.view === "matrix" ? "matrix" : "build";
  const access = await getProjectAccess(id);
  const canEdit = access.permissions.has("project.edit");
  const ccy = (await one<{ currency: string }>(`SELECT currency FROM project WHERE id=$1`, [id]))?.currency ?? "USD";

  const objectives = await q<{ id: string; level: string; code: string; statement: string; narrative: string | null }>(
    `SELECT id, level, code, statement, narrative FROM objective WHERE project_id=$1 ORDER BY (level='goal') DESC, "order", code`, [id]
  );
  const outputs = await q<{ id: string; objectiveId: string | null; code: string; statement: string }>(
    `SELECT id, objective_id AS "objectiveId", code, statement FROM output WHERE project_id=$1 ORDER BY "order", code`, [id]
  );
  const indicators = await q<{
    id: string; objectiveId: string | null; outputId: string | null; name: string;
    baseline: number; target: number; unit: string; mov: string | null; assumptions: string | null; latest: number;
  }>(
    `SELECT i.id, i.objective_id AS "objectiveId", i.output_id AS "outputId", i.name,
            i.baseline, i.target, i.unit, i.means_of_verification AS mov, i.assumptions,
            COALESCE((SELECT value FROM indicator_actual WHERE indicator_id=i.id ORDER BY recorded_at DESC LIMIT 1),0) AS latest
     FROM indicator i
     LEFT JOIN objective o ON o.id = i.objective_id
     LEFT JOIN output op ON op.id = i.output_id
     WHERE COALESCE(o.project_id, (SELECT project_id FROM output WHERE id=i.output_id)) = $1
     ORDER BY i.name`, [id]
  );
  // Workplan activities with their output link + linked budget line (live planned/actual).
  const activities = await q<{ id: string; outputId: string | null; budgetLineId: string | null; code: string | null; title: string; status: string; progress: number; blCode: string | null; planned: number; actual: number }>(
    `SELECT a.id, a.output_id AS "outputId", a.budget_line_id AS "budgetLineId", a.code, a.title, a.status, a.progress,
            bl.code AS "blCode", COALESCE(bl.planned,0) AS planned,
            COALESCE((SELECT SUM(amount) FROM expenditure WHERE budget_line_id=a.budget_line_id),0) AS actual
     FROM activity a LEFT JOIN budget_line bl ON bl.id=a.budget_line_id
     WHERE a.project_id=$1 AND a.type<>'task'
     ORDER BY a.code NULLS LAST, a.title`, [id]
  );

  // Recorded progress readings (the monitoring log) for every indicator in the project.
  const actuals = await q<{ id: string; indicatorId: string; indicatorName: string; period: string; value: number; note: string | null; recordedAt: string }>(
    `SELECT a.id, a.indicator_id AS "indicatorId", i.name AS "indicatorName", a.period, a.value, a.note, a.recorded_at AS "recordedAt"
     FROM indicator_actual a JOIN indicator i ON i.id = a.indicator_id
     LEFT JOIN objective o ON o.id = i.objective_id
     LEFT JOIN output op ON op.id = i.output_id
     WHERE COALESCE(o.project_id, (SELECT project_id FROM output WHERE id=i.output_id)) = $1
     ORDER BY a.recorded_at DESC`, [id]
  );

  const indFor = (objId: string, outIds: string[]) =>
    indicators.filter((i) => i.objectiveId === objId || (i.outputId && outIds.includes(i.outputId)));
  const actualsFor = (indIds: string[]) => actuals.filter((a) => indIds.includes(a.indicatorId));
  const actsFor = (outId: string) => activities.filter((a) => a.outputId === outId);
  // Output budget rolls up distinct linked budget lines (so shared lines aren't double-counted).
  function outputBudget(acts: typeof activities) {
    const seen = new Set<string>(); let planned = 0, actual = 0;
    for (const a of acts) { if (a.budgetLineId && !seen.has(a.budgetLineId)) { seen.add(a.budgetLineId); planned += a.planned; actual += a.actual; } }
    return { planned, actual };
  }
  const avgProgress = (acts: typeof activities) => acts.length ? Math.round(acts.reduce((s, a) => s + a.progress, 0) / acts.length) : 0;

  function indicatorProgress(i: { baseline: number; target: number; latest: number }) {
    const denom = i.target - i.baseline;
    if (denom === 0) return i.latest >= i.target ? 100 : 0;
    return Math.max(0, Math.min(100, ((i.latest - i.baseline) / denom) * 100));
  }

  const unlinkedActs = activities.filter((a) => !a.outputId);
  const empty = objectives.length === 0 && outputs.length === 0;
  const goals = objectives.filter((o) => o.level === "goal");
  const objs = objectives.filter((o) => o.level !== "goal");
  const objProgress = (objId: string, outIds: string[]) => {
    const inds = indFor(objId, outIds);
    if (!inds.length) return null;
    return Math.round(inds.reduce((s, i) => s + indicatorProgress(i), 0) / inds.length);
  };

  const Toggle = (
    <div className="flex items-center gap-2">
      <Link href={`/projects/${id}/logframe`} className="btn btn-sm" style={view === "build" ? { borderColor: "var(--brand)", background: "var(--surface)" } : undefined}>Builder</Link>
      <Link href={`/projects/${id}/logframe?view=matrix`} className="btn btn-sm" style={view === "matrix" ? { borderColor: "var(--brand)", background: "var(--surface)" } : undefined}>Matrix &amp; visual</Link>
    </div>
  );

  // ---------- MATRIX & VISUAL VIEW (read-only, donor-standard) ----------
  if (view === "matrix") {
    type Ind = typeof indicators[number];
    const indCell = (inds: Ind[]) => inds.length ? (
      <div className="space-y-1">
        {inds.map((i) => {
          const p = Math.round(indicatorProgress(i));
          return (
            <div key={i.id}>
              <div><span className="font-medium">{i.name}</span> <span className="text-xs" style={{ color: "var(--muted)" }}>({i.unit})</span></div>
              <div className="text-xs tabular-nums">{num(i.baseline)} → <span className="font-medium">{num(i.latest)}</span> / {num(i.target)} <Badge tone={p >= 100 ? "ok" : p >= 50 ? "brand" : "warn"}>{p}%</Badge></div>
            </div>
          );
        })}
      </div>
    ) : <span style={{ color: "var(--muted)" }}>—</span>;
    const joinCell = (vals: (string | null)[]) => { const v = vals.filter(Boolean) as string[]; return v.length ? v.join("; ") : <span style={{ color: "var(--muted)" }}>—</span>; };
    const objInds = (objId: string) => indicators.filter((i) => i.objectiveId === objId);
    const outInds = (outId: string) => indicators.filter((i) => i.outputId === outId);

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <SectionTitle>Logical framework</SectionTitle>
          {Toggle}
        </div>

        {empty ? <Empty title="No logframe yet" hint="Switch to the Builder to add objectives, outputs and indicators." /> : (<>
          {/* Results-chain visual */}
          <div className="card p-5">
            <SectionTitle>Results chain</SectionTitle>
            <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>How activities deliver outputs, which achieve the objectives, which contribute to the goal. Progress is live — from indicators and the work plan.</p>
            {goals.map((g) => (
              <div key={g.id} className="rounded-lg p-3 mb-1" style={{ background: "var(--surface)", borderLeft: "4px solid var(--ok)" }}>
                <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>Goal · {g.code}</div>
                <div className="font-medium">{g.statement}</div>
              </div>
            ))}
            {goals.length > 0 && objs.length > 0 && <div className="text-center text-xs my-1" style={{ color: "var(--muted)" }}>▲ contributes to</div>}
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {objs.map((o) => {
                const outs = outputs.filter((x) => x.objectiveId === o.id);
                const p = objProgress(o.id, outs.map((x) => x.id));
                return (
                  <div key={o.id} className="rounded-lg p-3" style={{ background: "var(--surface)", borderLeft: "4px solid var(--brand)" }}>
                    <div className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>Objective · {o.code}</div>
                    <div className="text-sm font-medium mb-1">{o.statement}</div>
                    {p !== null && <ProgressBar value={p} tone={p >= 100 ? "ok" : p >= 50 ? "brand" : "warn"} showLabel />}
                  </div>
                );
              })}
            </div>
            {outputs.length > 0 && <div className="text-center text-xs my-1" style={{ color: "var(--muted)" }}>▲ delivered by outputs</div>}
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {outputs.map((o) => {
                const acts = actsFor(o.id); const b = outputBudget(acts); const p = avgProgress(acts);
                return (
                  <div key={o.id} className="rounded-lg p-2 text-sm" style={{ border: "1px solid var(--border)" }}>
                    <div className="text-xs font-mono" style={{ color: "var(--muted)" }}>{o.code}</div>
                    <div className="mb-1">{o.statement}</div>
                    {acts.length > 0 ? <><ProgressBar value={p} tone={p >= 100 ? "ok" : "brand"} showLabel /><div className="text-xs mt-1" style={{ color: "var(--muted)" }}>{acts.length} activit{acts.length === 1 ? "y" : "ies"} · {money(b.actual, ccy)} / {money(b.planned, ccy)}</div></> : <div className="text-xs" style={{ color: "var(--muted)" }}>no activities linked</div>}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Canonical logframe matrix */}
          <div className="card overflow-x-auto">
            <div className="p-4 pb-2 flex items-center justify-between">
              <SectionTitle>Logical framework matrix</SectionTitle>
              <a href={`/print/logframe/${id}`} target="_blank" rel="noopener" className="btn btn-sm">Print / PDF</a>
            </div>
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left" style={{ width: "32%" }}>Results / narrative summary</th>
                <th className="th text-left">Indicators · baseline → latest / target</th>
                <th className="th text-left">Means of verification</th>
                <th className="th text-left">Assumptions</th>
              </tr></thead>
              <tbody>
                {goals.length > 0 && <tr><td colSpan={4} className="td" style={{ background: "var(--surface)", fontWeight: 700 }}>GOAL</td></tr>}
                {goals.map((g) => { const inds = objInds(g.id); return (
                  <tr key={g.id}>
                    <td className="td"><span className="font-mono text-xs mr-1" style={{ color: "var(--muted)" }}>{g.code}</span>{g.statement}{g.narrative && <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>{g.narrative}</div>}</td>
                    <td className="td">{indCell(inds)}</td><td className="td text-xs">{joinCell(inds.map((i) => i.mov))}</td><td className="td text-xs">{joinCell(inds.map((i) => i.assumptions))}</td>
                  </tr>
                ); })}

                {objs.length > 0 && <tr><td colSpan={4} className="td" style={{ background: "var(--surface)", fontWeight: 700 }}>OBJECTIVES / OUTCOMES</td></tr>}
                {objs.map((o) => { const inds = objInds(o.id); return (
                  <tr key={o.id}>
                    <td className="td"><span className="font-mono text-xs mr-1" style={{ color: "var(--muted)" }}>{o.code}</span>{o.statement}{o.narrative && <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>{o.narrative}</div>}</td>
                    <td className="td">{indCell(inds)}</td><td className="td text-xs">{joinCell(inds.map((i) => i.mov))}</td><td className="td text-xs">{joinCell(inds.map((i) => i.assumptions))}</td>
                  </tr>
                ); })}

                {outputs.length > 0 && <tr><td colSpan={4} className="td" style={{ background: "var(--surface)", fontWeight: 700 }}>OUTPUTS</td></tr>}
                {outputs.map((o) => { const inds = outInds(o.id); return (
                  <tr key={o.id}>
                    <td className="td"><span className="font-mono text-xs mr-1" style={{ color: "var(--muted)" }}>{o.code}</span>{o.statement}</td>
                    <td className="td">{indCell(inds)}</td><td className="td text-xs">{joinCell(inds.map((i) => i.mov))}</td><td className="td text-xs">{joinCell(inds.map((i) => i.assumptions))}</td>
                  </tr>
                ); })}

                {activities.length > 0 && <tr><td colSpan={4} className="td" style={{ background: "var(--surface)", fontWeight: 700 }}>ACTIVITIES <span className="text-xs font-normal" style={{ color: "var(--muted)" }}>· from the work plan, with live budget</span></td></tr>}
                {outputs.map((o) => actsFor(o.id).map((a) => (
                  <tr key={a.id}>
                    <td className="td"><span className="font-mono text-xs mr-1" style={{ color: "var(--muted)" }}>{a.code ?? o.code}</span>{a.title}</td>
                    <td className="td"><ProgressBar value={a.progress} tone={a.progress >= 100 ? "ok" : "brand"} showLabel /></td>
                    <td className="td text-xs">{a.blCode ? `Budget ${a.blCode}` : "—"}</td>
                    <td className="td text-xs tabular-nums">{a.budgetLineId ? `${money(a.actual, ccy)} / ${money(a.planned, ccy)}` : "—"}</td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </>)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">{Toggle}</div>
      {sp.imported !== undefined && (() => {
        const v = sp.imported as string;
        const ok = v !== "nofile" && (Number(v) || 0) > 0;
        const n = Number(v) || 0;
        const text = v === "nofile"
          ? "Choose a file first, then click Upload & extract."
          : ok
            ? `Imported ${n} item${n === 1 ? "" : "s"} from your document — review and edit them below.`
            : "No objectives or outputs were detected in that document. It may use a layout the extractor can't read yet — add them by hand below, or send the file to support so the extractor can be taught its format.";
        return (
          <div className="card p-3 flex items-start gap-2" style={{ borderColor: ok ? "var(--ok)" : "var(--warn)" }}>
            <span className="mt-1 inline-block h-2 w-2 rounded-full" style={{ background: ok ? "var(--ok)" : "var(--warn)" }} />
            <p className="text-sm">{text}</p>
          </div>
        );
      })()}
      {canEdit && (
        <div className="card p-4">
          <SectionTitle>Populate the results framework</SectionTitle>
          <p className="text-sm mb-3" style={{ color: "var(--muted)" }}>
            Upload a proposal or concept note to auto-extract objectives and outputs — or add them by hand below. Everything stays editable.
          </p>
          <form action={uploadObjectivesAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="projectId" value={id} />
            <input type="file" name="file" accept=".docx,.pdf,.doc,.txt,.md" className="input" />
            <button className="btn btn-primary" type="submit">Upload &amp; extract</button>
          </form>
        </div>
      )}

      {empty && !canEdit && <Empty title="No logframe yet" hint="No objectives or indicators have been added." />}

      {objectives.map((obj) => {
        const objOutputs = outputs.filter((o) => o.objectiveId === obj.id);
        const objInds = indFor(obj.id, objOutputs.map((o) => o.id));
        return (
          <div key={obj.id} className="card p-5">
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="flex items-center gap-2">
                <Badge tone={obj.level === "goal" ? "ok" : "brand"}>{obj.code}</Badge>
                <span className="text-xs uppercase tracking-wide" style={{ color: "var(--muted)" }}>{obj.level === "goal" ? "Goal" : "Objective"}</span>
              </div>
              {canEdit && (
                <div className="flex items-center gap-1">
                  <details className="editor inline-block">
                    <summary className="btn btn-sm">Edit</summary>
                    <div className="editor-panel card p-4">
                      <SectionTitle>Edit objective</SectionTitle>
                      <form action={updateObjectiveAction} className="space-y-2 mt-2">
                        <input type="hidden" name="projectId" value={id} />
                        <input type="hidden" name="objectiveId" value={obj.id} />
                        <div className="grid grid-cols-2 gap-2">
                          <Field label="Code"><input name="code" className="input" defaultValue={obj.code} /></Field>
                          <Field label="Level"><select name="level" className="select" defaultValue={obj.level}><option value="objective">Objective</option><option value="goal">Goal</option></select></Field>
                        </div>
                        <Field label="Statement"><textarea name="statement" required className="textarea" rows={3} defaultValue={obj.statement} /></Field>
                        <Field label="Narrative (optional)"><textarea name="narrative" className="textarea" rows={2} defaultValue={obj.narrative ?? ""} /></Field>
                        <button className="btn btn-primary w-full" type="submit">Save changes</button>
                      </form>
                    </div>
                  </details>
                  <form action={deleteObjectiveAction}>
                    <input type="hidden" name="projectId" value={id} />
                    <input type="hidden" name="objectiveId" value={obj.id} />
                    <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button>
                  </form>
                </div>
              )}
            </div>
            <h3 className="font-display text-lg font-semibold">{obj.statement}</h3>
            {obj.narrative && <p className="text-sm mt-1" style={{ color: "var(--muted)" }}>{obj.narrative}</p>}

            {objOutputs.length > 0 && (
              <div className="mt-3 space-y-3">
                {objOutputs.map((o) => {
                  const acts = actsFor(o.id);
                  const ob = outputBudget(acts);
                  const prog = avgProgress(acts);
                  return (
                    <div key={o.id} className="rounded border p-3" style={{ borderColor: "var(--border)" }}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="text-sm flex gap-2">
                          <span className="font-mono text-xs mt-0.5" style={{ color: "var(--muted)" }}>{o.code}</span>
                          <span className="font-medium">{o.statement}</span>
                        </div>
                        {acts.length > 0 && <div className="text-xs text-right whitespace-nowrap" style={{ color: "var(--muted)" }}>Delivery {prog}%<br />Budget {money(ob.actual, ccy)} / {money(ob.planned, ccy)}</div>}
                      </div>
                      {acts.length > 0 && (
                        <div className="mt-2 overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead><tr><th className="th text-left">Activity (work plan)</th><th className="th text-left">Status</th><th className="th text-left" style={{ width: 120 }}>Progress</th><th className="th text-left">Budget line</th><th className="th text-right">Spent / planned</th>{canEdit && <th className="th" />}</tr></thead>
                            <tbody>
                              {acts.map((a) => (
                                <tr key={a.id}>
                                  <td className="td">{a.code ? <span className="font-mono text-xs mr-1" style={{ color: "var(--muted)" }}>{a.code}</span> : null}{a.title}</td>
                                  <td className="td"><Badge tone={a.status === "done" ? "ok" : a.status === "in_progress" ? "brand" : "muted"}>{label(a.status)}</Badge></td>
                                  <td className="td"><ProgressBar value={a.progress} tone={a.progress >= 100 ? "ok" : "brand"} showLabel /></td>
                                  <td className="td font-mono text-xs">{a.blCode ?? "—"}</td>
                                  <td className="td text-right tabular-nums">{a.budgetLineId ? `${money(a.actual, ccy)} / ${money(a.planned, ccy)}` : "—"}</td>
                                  {canEdit && <td className="td text-right"><form action={linkActivityToOutputAction}><input type="hidden" name="projectId" value={id} /><input type="hidden" name="activityId" value={a.id} /><input type="hidden" name="outputId" value="" /><button className="btn btn-sm" type="submit" title="Unlink from this output">✕</button></form></td>}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                      {canEdit && unlinkedActs.length > 0 && (
                        <form action={linkActivityToOutputAction} className="flex items-end gap-2 mt-2">
                          <input type="hidden" name="projectId" value={id} />
                          <input type="hidden" name="outputId" value={o.id} />
                          <Field label="Link a work-plan activity to this output">
                            <select name="activityId" required className="select" style={{ minWidth: 240 }}>
                              <option value="">— choose activity —</option>
                              {unlinkedActs.map((a) => <option key={a.id} value={a.id}>{a.code ? a.code + " " : ""}{a.title}</option>)}
                            </select>
                          </Field>
                          <div className="pb-0.5"><button className="btn btn-sm btn-primary" type="submit">Link</button></div>
                        </form>
                      )}
                      {acts.length === 0 && !canEdit && <p className="text-xs mt-1" style={{ color: "var(--muted)" }}>No work-plan activities linked yet.</p>}
                    </div>
                  );
                })}
              </div>
            )}

            {objInds.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr>
                    <th className="th text-left">Indicator</th>
                    <th className="th text-right">Baseline</th>
                    <th className="th text-right">Latest</th>
                    <th className="th text-right">Target</th>
                    <th className="th text-left" style={{ width: 160 }}>Progress</th>
                    <th className="th text-left">Verification</th>
                    {canEdit && <th className="th" />}
                  </tr></thead>
                  <tbody>
                    {objInds.map((i) => {
                      const p = indicatorProgress(i);
                      return (
                        <tr key={i.id}>
                          <td className="td">{i.name} <span className="text-xs" style={{ color: "var(--muted)" }}>({i.unit})</span></td>
                          <td className="td text-right tabular-nums">{num(i.baseline)}</td>
                          <td className="td text-right tabular-nums font-medium">{num(i.latest)}</td>
                          <td className="td text-right tabular-nums">{num(i.target)}</td>
                          <td className="td"><ProgressBar value={p} tone={p >= 100 ? "ok" : p >= 50 ? "brand" : "warn"} showLabel /></td>
                          <td className="td text-xs" style={{ color: "var(--muted)" }}>{i.mov ?? "—"}{i.assumptions ? <span><br />Assumes: {i.assumptions}</span> : null}</td>
                          {canEdit && (
                            <td className="td">
                              <div className="flex items-center gap-1 justify-end">
                                <details className="editor inline-block">
                                  <summary className="btn btn-sm btn-primary">Record</summary>
                                  <div className="editor-panel card p-4">
                                    <SectionTitle>Record progress</SectionTitle>
                                    <p className="text-xs mb-2" style={{ color: "var(--muted)" }}>{i.name}</p>
                                    <form action={recordIndicatorActualAction} className="space-y-2">
                                      <input type="hidden" name="projectId" value={id} />
                                      <input type="hidden" name="indicatorId" value={i.id} />
                                      <Field label="Period (e.g. Q1 2026, Mar 2026)"><input name="period" required className="input" placeholder="Q1 2026" /></Field>
                                      <Field label={`Cumulative value (${i.unit || "number"})`}><input type="number" step="any" name="value" required className="input" defaultValue={i.latest || 0} /></Field>
                                      <Field label="What was done (optional)"><textarea name="note" className="textarea" rows={2} placeholder="e.g. 6 FGDs completed across 3 sub-counties" /></Field>
                                      <div className="text-xs" style={{ color: "var(--muted)" }}>Baseline {num(i.baseline)} · Target {num(i.target)}</div>
                                      <button className="btn btn-primary w-full" type="submit">Save reading</button>
                                    </form>
                                  </div>
                                </details>
                                <details className="editor inline-block">
                                  <summary className="btn btn-sm">Edit</summary>
                                  <div className="editor-panel card p-4">
                                    <SectionTitle>Edit indicator</SectionTitle>
                                    <form action={updateIndicatorAction} className="space-y-2 mt-2">
                                      <input type="hidden" name="projectId" value={id} />
                                      <input type="hidden" name="indicatorId" value={i.id} />
                                      <Field label="Indicator name"><textarea name="name" required className="textarea" rows={2} defaultValue={i.name} /></Field>
                                      <div className="grid grid-cols-3 gap-2">
                                        <Field label="Unit"><input name="unit" className="input" defaultValue={i.unit} /></Field>
                                        <Field label="Baseline"><input type="number" step="any" name="baseline" className="input" defaultValue={i.baseline} /></Field>
                                        <Field label="Target"><input type="number" step="any" name="target" className="input" defaultValue={i.target} /></Field>
                                      </div>
                                      <Field label="Means of verification"><input name="mov" className="input" defaultValue={i.mov ?? ""} /></Field>
                                      <Field label="Assumptions"><input name="assumptions" className="input" defaultValue={i.assumptions ?? ""} /></Field>
                                      <button className="btn btn-primary w-full" type="submit">Save changes</button>
                                    </form>
                                  </div>
                                </details>
                                <form action={deleteIndicatorAction}>
                                  <input type="hidden" name="projectId" value={id} />
                                  <input type="hidden" name="indicatorId" value={i.id} />
                                  <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }} title="Delete indicator">✕</button>
                                </form>
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {objInds.length > 0 && (() => {
              const logs = actualsFor(objInds.map((i) => i.id));
              return (
                <div className="mt-4">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs uppercase tracking-wide font-medium" style={{ color: "var(--muted)" }}>Progress monitoring</span>
                    <Badge tone="muted">{logs.length} reading{logs.length === 1 ? "" : "s"}</Badge>
                  </div>
                  {logs.length === 0 ? (
                    <p className="text-xs" style={{ color: "var(--muted)" }}>No progress recorded yet. Use <b>Record</b> on an indicator above to log what has been achieved each period — those readings update the Latest column and the progress bars.</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><tr>
                          <th className="th text-left" style={{ width: 100 }}>Recorded</th>
                          <th className="th text-left">Indicator</th>
                          <th className="th text-left" style={{ width: 110 }}>Period</th>
                          <th className="th text-right" style={{ width: 70 }}>Value</th>
                          <th className="th text-left">What was done</th>
                          {canEdit && <th className="th" style={{ width: 36 }} />}
                        </tr></thead>
                        <tbody>
                          {logs.map((a) => (
                            <tr key={a.id}>
                              <td className="td text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>{fmtDate(a.recordedAt)}</td>
                              <td className="td">{a.indicatorName}</td>
                              <td className="td">{a.period}</td>
                              <td className="td text-right tabular-nums font-medium">{num(a.value)}</td>
                              <td className="td text-xs" style={{ color: "var(--muted)" }}>{a.note ?? "—"}</td>
                              {canEdit && <td className="td text-right"><form action={deleteIndicatorActualAction}><input type="hidden" name="projectId" value={id} /><input type="hidden" name="actualId" value={a.id} /><button className="btn btn-sm" type="submit" title="Remove reading" style={{ color: "var(--danger)" }}>✕</button></form></td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}

            {canEdit && (
              <details className="mt-3">
                <summary className="btn btn-sm cursor-pointer inline-block">+ Add indicator</summary>
                <form action={addIndicatorAction} className="card p-3 mt-2 grid sm:grid-cols-6 gap-2 items-end">
                  <input type="hidden" name="projectId" value={id} />
                  <input type="hidden" name="objectiveId" value={obj.id} />
                  <div className="sm:col-span-2"><Field label="Indicator name"><input name="name" required className="input" /></Field></div>
                  <Field label="Unit"><input name="unit" className="input" placeholder="%" /></Field>
                  <Field label="Baseline"><input type="number" step="any" name="baseline" defaultValue={0} className="input" /></Field>
                  <Field label="Target"><input type="number" step="any" name="target" defaultValue={0} className="input" /></Field>
                  <div className="sm:col-span-5"><Field label="Means of verification"><input name="mov" className="input" /></Field></div>
                  <button className="btn btn-primary" type="submit">Add</button>
                </form>
              </details>
            )}
          </div>
        );
      })}

      {canEdit && (
        <div className="card p-4">
          <SectionTitle>Add an objective</SectionTitle>
          <form action={addObjectiveAction} className="grid sm:grid-cols-6 gap-3 items-end">
            <input type="hidden" name="projectId" value={id} />
            <Field label="Code"><input name="code" className="input" placeholder="OBJ1" /></Field>
            <div className="sm:col-span-3"><Field label="Objective statement"><input name="statement" required className="input" placeholder="e.g. Reduce schistosomiasis prevalence among schoolchildren" /></Field></div>
            <div className="sm:col-span-2"><Field label="Narrative (optional)"><input name="narrative" className="input" /></Field></div>
            <button className="btn btn-primary" type="submit">Add objective</button>
          </form>
        </div>
      )}
    </div>
  );
}
