import { q, one } from "@/server/db";
import { getProjectAccess } from "@/server/policy";
import { SectionTitle, Empty, ProgressBar, Badge, Field } from "@/components/ui";
import { num, money } from "@/lib/format";
import { label } from "@/lib/enums";
import { addObjectiveAction, deleteObjectiveAction, addIndicatorAction, deleteIndicatorAction, uploadObjectivesAction, linkActivityToOutputAction } from "@/app/actions";

export default async function LogframePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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

  const indFor = (objId: string, outIds: string[]) =>
    indicators.filter((i) => i.objectiveId === objId || (i.outputId && outIds.includes(i.outputId)));
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

  return (
    <div className="space-y-6">
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
                <form action={deleteObjectiveAction}>
                  <input type="hidden" name="projectId" value={id} />
                  <input type="hidden" name="objectiveId" value={obj.id} />
                  <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete</button>
                </form>
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
                            <td className="td text-right">
                              <form action={deleteIndicatorAction}>
                                <input type="hidden" name="projectId" value={id} />
                                <input type="hidden" name="indicatorId" value={i.id} />
                                <button className="btn btn-sm" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>✕</button>
                              </form>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

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
