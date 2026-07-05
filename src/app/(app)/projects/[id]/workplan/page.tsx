import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { updateActivityAction, addActivityAction, uploadWorkplanAction, workplanFromBudgetAction, editActivityDetailsAction, deleteActivityAction, uploadActivityEvidenceAction, assignActivityLeadAction } from "@/app/actions";
import { type GanttRow } from "@/components/gantt";
import { StatusBadge, SectionTitle, Empty, Field, ProgressBar, progressTone } from "@/components/ui";
import { ACTIVITY_STATUS, label } from "@/lib/enums";
import { fmtDate, dateInput } from "@/lib/format";

type Row = GanttRow & { parentId: string | null; ownerName: string | null; ownerId: string | null };

export default async function WorkplanPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);
  const canEdit = access.permissions.has("project.edit");
  const proj = await one<{ mode: string }>(`SELECT mode FROM project WHERE id=$1`, [id]);
  const budgetLineCount = (await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM budget_line bl JOIN budget b ON b.id=bl.budget_id WHERE b.project_id=$1`, [id]
  ))?.c ?? 0;

  const evid = await q<{ activityId: string; docId: string; name: string }>(
    `SELECT ae.activity_id AS "activityId", d.id AS "docId", d.name
     FROM activity_evidence ae JOIN project_document d ON d.id=ae.document_id
     WHERE ae.activity_id IN (SELECT id FROM activity WHERE project_id=$1) ORDER BY ae.created_at`, [id]
  );
  const evidByAct = new Map<string, { docId: string; name: string }[]>();
  for (const e of evid) {
    const arr = evidByAct.get(e.activityId) ?? []; arr.push({ docId: e.docId, name: e.name }); evidByAct.set(e.activityId, arr);
  }

  const members = await q<{ userId: string; name: string }>(
    `SELECT pm.user_id AS "userId", u.name FROM project_member pm JOIN app_user u ON u.id=pm.user_id WHERE pm.project_id=$1 ORDER BY u.name`, [id]
  );
  // Collaborators linked to this project who have a portal login can also be
  // assigned as activity leads. Those without a login are surfaced as a hint so
  // the PI knows to create one (from Collaborations) before assigning them.
  const collaborators = await q<{ userId: string; name: string }>(
    `SELECT c.user_id AS "userId", (CASE WHEN c.prefix IS NOT NULL AND c.prefix<>'' THEN c.prefix||' ' ELSE '' END)||c.name AS name
     FROM project_collaborator pc JOIN collaborator c ON c.id=pc.collaborator_id
     WHERE pc.project_id=$1 AND c.user_id IS NOT NULL ORDER BY c.name`, [id]
  );
  const collaboratorsWithoutLogin = (await one<{ c: number }>(
    `SELECT COUNT(*)::int c FROM project_collaborator pc JOIN collaborator c ON c.id=pc.collaborator_id
     WHERE pc.project_id=$1 AND c.user_id IS NULL`, [id]
  ))?.c ?? 0;
  const canAssign = access.permissions.has("project.edit");

  const rows = await q<Row>(
    `SELECT a.id, a.code, a.title, a.type, a.status, a.progress,
            a.start_date AS "startDate", a.end_date AS "endDate", a.parent_id AS "parentId",
            u.name AS "ownerName", a.owner_id AS "ownerId"
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
                {canEdit && <th className="th text-right">Edit</th>}
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
                    {canEdit && (
                      <td className="td text-right whitespace-nowrap">
                        <details className="editor inline-block">
                          <summary className="btn btn-sm inline-block">Edit</summary>
                          <div className="editor-panel card p-4 text-left">
                            <div className="font-medium mb-3">Edit activity</div>
                            <form action={editActivityDetailsAction} className="grid gap-2">
                              <input type="hidden" name="projectId" value={id} />
                              <input type="hidden" name="activityId" value={r.id} />
                              <Field label="Code"><input name="code" defaultValue={r.code ?? ""} className="input" /></Field>
                              <Field label="Title"><input name="title" defaultValue={r.title} className="input" /></Field>
                              <div className="grid grid-cols-2 gap-2">
                                <Field label="Start"><input type="date" name="startDate" defaultValue={dateInput(r.startDate)} className="input" /></Field>
                                <Field label="End"><input type="date" name="endDate" defaultValue={dateInput(r.endDate)} className="input" /></Field>
                              </div>
                              <button className="btn btn-primary btn-sm" type="submit">Save changes</button>
                            </form>
                            {canAssign && (
                              <form action={assignActivityLeadAction} className="grid gap-2 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                                <input type="hidden" name="projectId" value={id} />
                                <input type="hidden" name="activityId" value={r.id} />
                                <Field label="Activity lead">
                                  <select name="ownerId" defaultValue={r.ownerId ?? ""} className="select">
                                    <option value="">— Unassigned —</option>
                                    {members.length > 0 && (
                                      <optgroup label="Team members">
                                        {members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                                      </optgroup>
                                    )}
                                    {collaborators.length > 0 && (
                                      <optgroup label="Collaborators">
                                        {collaborators.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                                      </optgroup>
                                    )}
                                  </select>
                                </Field>
                                <button className="btn btn-sm" type="submit">Assign &amp; notify</button>
                                <p className="text-xs" style={{ color: "var(--muted)" }}>
                                  The person is notified in-app and by email.
                                  {collaboratorsWithoutLogin > 0 && ` ${collaboratorsWithoutLogin} linked collaborator${collaboratorsWithoutLogin === 1 ? "" : "s"} need a login before they can be assigned — create one from Collaborations.`}
                                </p>
                              </form>
                            )}
                            <div className="hidden" />
                            <form action={deleteActivityAction} className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                              <input type="hidden" name="projectId" value={id} />
                              <input type="hidden" name="activityId" value={r.id} />
                              <button className="btn btn-sm w-full" type="submit" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>Delete{hasChildren ? " (incl. sub-activities)" : ""}</button>
                            </form>
                            <div className="mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
                              <div className="text-xs font-medium mb-1" style={{ color: "var(--muted)" }}>Completion evidence</div>
                              {(evidByAct.get(r.id) ?? []).length === 0
                                ? <div className="text-xs" style={{ color: "var(--muted)" }}>None yet — attach an activity report, photos, attendance list…</div>
                                : (
                                  <ul className="text-xs space-y-1 mb-1">
                                    {(evidByAct.get(r.id) ?? []).map((e) => (
                                      <li key={e.docId}><a href={`/api/files/${e.docId}`} className="hover:underline" style={{ color: "var(--brand)" }}>📎 {e.name}</a></li>
                                    ))}
                                  </ul>
                                )}
                              <form action={uploadActivityEvidenceAction} className="flex items-end gap-2 mt-2">
                                <input type="hidden" name="projectId" value={id} />
                                <input type="hidden" name="activityId" value={r.id} />
                                <input type="file" name="file" required className="input" style={{ fontSize: 12 }} />
                                <button className="btn btn-sm" type="submit">Attach</button>
                              </form>
                            </div>
                            <div className="text-xs mt-3 text-center" style={{ color: "var(--muted)" }}>Click outside or “Edit” again to close.</div>
                          </div>
                        </details>
                      </td>
                    )}
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
