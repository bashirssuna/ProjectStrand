import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { updateActivityAction, addActivityAction, uploadWorkplanAction, workplanFromBudgetAction } from "@/app/actions";
import { Gantt, type GanttRow } from "@/components/gantt";
import { StatusBadge, SectionTitle, Empty, Field, ProgressBar, progressTone } from "@/components/ui";
import { ACTIVITY_STATUS, label } from "@/lib/enums";
import { fmtDate } from "@/lib/format";

type Row = GanttRow & { parentId: string | null; ownerName: string | null };

export default async function WorkplanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);
  const canEdit = access.permissions.has("project.edit");
  const proj = await one<{ mode: string }>(`SELECT mode FROM project WHERE id=$1`, [id]);
  const budgetLineCount = (await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM budget_line bl JOIN budget b ON b.id=bl.budget_id WHERE b.project_id=$1`, [id]
  ))?.c ?? 0;

  const rows = await q<Row>(
    `SELECT a.id, a.code, a.title, a.type, a.status, a.progress,
            a.start_date AS "startDate", a.end_date AS "endDate", a.parent_id AS "parentId",
            u.name AS "ownerName"
     FROM activity a LEFT JOIN app_user u ON u.id = a.owner_id
     WHERE a.project_id=$1 ORDER BY a."order", a.created_at`, [id]
  );

  // order children under parents while keeping a flat render list with depth
  const byParent = new Map<string | null, Row[]>();
  for (const r of rows) {
    const k = r.parentId ?? null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k)!.push(r);
  }
  const flat: { row: Row; depth: number; hasChildren: boolean }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const r of byParent.get(parent) ?? []) {
      flat.push({ row: r, depth, hasChildren: (byParent.get(r.id)?.length ?? 0) > 0 });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);

  return (
    <div className="space-y-7">
      <div>
        <SectionTitle>Timeline</SectionTitle>
        <Gantt rows={rows} />
      </div>

      <div>
        <SectionTitle>Activities</SectionTitle>
        {rows.length === 0 ? (
          <Empty title="No activities yet" hint={canEdit ? "Add your first activity below, or import a work plan." : "No activities have been added."} />
        ) : (
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr>
                <th className="th text-left" style={{ minWidth: 280 }}>Activity</th>
                <th className="th text-left">Owner</th>
                <th className="th text-left">Dates</th>
                <th className="th text-left">Status</th>
                <th className="th text-left" style={{ width: 200 }}>Progress</th>
              </tr></thead>
              <tbody>
                {flat.map(({ row: r, depth, hasChildren }) => {
                  const editableProgress = canEdit && !hasChildren && r.type !== "milestone";
                  return (
                  <tr key={r.id} className={depth === 0 ? "font-medium" : ""}>
                    <td className="td">
                      <div style={{ paddingLeft: depth * 18 }} className="flex items-center gap-2">
                        {r.type === "milestone" && <span title="Milestone" style={{ color: "var(--brand)" }}>◆</span>}
                        {r.code && <span className="font-mono text-xs" style={{ color: "var(--muted)" }}>{r.code}</span>}
                        <span>{r.title}</span>
                      </div>
                    </td>
                    <td className="td" style={{ color: r.ownerName ? undefined : "var(--muted)" }}>{r.ownerName ?? "Unassigned"}</td>
                    <td className="td whitespace-nowrap text-xs" style={{ color: "var(--muted)" }}>
                      {fmtDate(r.startDate)} → {fmtDate(r.endDate)}
                    </td>
                    {canEdit ? (
                      <td className="td">
                        <form action={updateActivityAction} className="flex items-center gap-2">
                          <input type="hidden" name="projectId" value={id} />
                          <input type="hidden" name="activityId" value={r.id} />
                          <select name="status" defaultValue={r.status} className="select" style={{ width: 130, padding: "4px 8px" }}>
                            {ACTIVITY_STATUS.map((s) => <option key={s} value={s}>{label(s)}</option>)}
                          </select>
                          {editableProgress
                            ? <input type="number" name="progress" defaultValue={r.progress} min={0} max={100} className="input" style={{ width: 64, padding: "4px 8px" }} />
                            : <input type="hidden" name="progress" value={r.progress} />}
                          <button className="btn btn-sm" type="submit">Save</button>
                        </form>
                      </td>
                    ) : (
                      <td className="td"><StatusBadge status={r.status} /></td>
                    )}
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <div className="flex-1"><ProgressBar value={r.progress} tone={progressTone(r.progress, r.status)} /></div>
                        <span className="tabular-nums text-xs w-9 text-right" style={{ color: "var(--muted)" }}>{r.progress}%</span>
                        {hasChildren && <span title="Rolled up from sub-activities" className="text-xs" style={{ color: "var(--muted)" }}>auto</span>}
                      </div>
                    </td>
                  </tr>
                );})}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canEdit && (
        <div>
          <SectionTitle>Populate the work plan</SectionTitle>
          <div className="grid md:grid-cols-2 gap-4">
            <form action={uploadWorkplanAction} className="card p-4 space-y-3">
              <div className="text-sm font-medium">Upload a work plan or Gantt</div>
              <input type="file" name="file" required accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" className="input" />
              <input type="hidden" name="projectId" value={id} />
              <button className="btn btn-primary" type="submit">Upload &amp; populate</button>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                Word/PDF work plans extract activity lines; Excel/CSV Gantt charts with Activity, Start
                and End columns populate dated activities automatically.
              </p>
            </form>
            <form action={workplanFromBudgetAction} className="card p-4 space-y-3">
              <div className="text-sm font-medium">Generate from the budget</div>
              <p className="text-sm" style={{ color: "var(--muted)" }}>
                {budgetLineCount > 0
                  ? `Create a starter activity for each of the ${budgetLineCount} budget lines — useful when no work plan document is available.`
                  : "No budget lines yet. Import or add a budget first, then generate activities from it."}
              </p>
              <input type="hidden" name="projectId" value={id} />
              <button className="btn btn-primary" type="submit" disabled={budgetLineCount === 0}>Generate from budget</button>
            </form>
          </div>
        </div>
      )}

      {canEdit && (
        <div>
          <SectionTitle>Add activity</SectionTitle>
          <form action={addActivityAction} className="card p-4 grid sm:grid-cols-5 gap-3 items-end">
            <input type="hidden" name="projectId" value={id} />
            <div className="sm:col-span-2"><Field label="Title"><input name="title" required className="input" placeholder="e.g. Conduct baseline survey" /></Field></div>
            <Field label="Code"><input name="code" className="input" placeholder="1.1" /></Field>
            <Field label="Start"><input type="date" name="startDate" className="input" /></Field>
            <div className="flex gap-2">
              <Field label="End"><input type="date" name="endDate" className="input" /></Field>
              <button className="btn btn-primary self-end" type="submit">Add</button>
            </div>
          </form>
        </div>
      )}

      {proj?.mode === "simple" && (
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          This project is in simple mode — activities and progress are tracked without the full logframe.
        </p>
      )}
    </div>
  );
}
