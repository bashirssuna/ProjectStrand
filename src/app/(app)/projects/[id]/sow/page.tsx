import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { ensureSowAction, updateSowSectionAction, approveSowAction, uploadSowAction } from "@/app/actions";
import { SectionTitle, Empty, StatusBadge, Badge } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export default async function SowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);
  const canEdit = access.permissions.has("project.edit");
  const canApprove = access.permissions.has("project.administer");

  const project = await one<{ title: string; donor: string | null; grantNumber: string | null; startDate: string | null; endDate: string | null }>(
    `SELECT title, donor, grant_number AS "grantNumber", start_date AS "startDate", end_date AS "endDate" FROM project WHERE id=$1`, [id]
  );
  const sow = await one<{ id: string; status: string; approvedAt: string | null }>(
    `SELECT id, status, approved_at AS "approvedAt" FROM sow WHERE project_id=$1`, [id]
  );
  const sections = sow ? await q<{ id: string; title: string; content: string; sourceRef: string | null }>(
    `SELECT id, title, content, source_ref AS "sourceRef" FROM sow_section WHERE sow_id=$1 ORDER BY "order"`, [sow.id]
  ) : [];

  if (!sow) {
    return (
      <div>
        <Empty title="No statement of work yet" hint={canEdit ? "Create a structured SOW with standard sections, or import a proposal to draft it." : "No SOW has been created."} />
        {canEdit && (
          <div className="mt-4 flex flex-col sm:flex-row gap-3">
            <form action={ensureSowAction}>
              <input type="hidden" name="projectId" value={id} />
              <button className="btn btn-primary" type="submit">Create blank SOW</button>
            </form>
            <form action={uploadSowAction} className="card p-4 flex flex-wrap items-end gap-3">
              <input type="hidden" name="projectId" value={id} />
              <label className="block">
                <span className="label">Upload a SOW document to populate it</span>
                <input type="file" name="file" required accept=".pdf,.doc,.docx,.txt,.md" className="input" />
              </label>
              <button className="btn btn-primary" type="submit">Upload &amp; populate</button>
            </form>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={sow.status} />
          {sow.approvedAt && <span className="text-xs" style={{ color: "var(--muted)" }}>Approved {fmtDate(sow.approvedAt)}</span>}
        </div>
        {canApprove && sow.status !== "approved" && (
          <form action={approveSowAction}>
            <input type="hidden" name="projectId" value={id} />
            <button className="btn btn-primary btn-sm" type="submit">Approve SOW</button>
          </form>
        )}
      </div>

      <div className="card p-5 grid sm:grid-cols-2 gap-y-2 gap-x-6 text-sm">
        <div><div className="label">Project title</div><div>{project?.title}</div></div>
        <div><div className="label">Donor / funder</div><div>{project?.donor ?? "—"}</div></div>
        <div><div className="label">Grant number</div><div>{project?.grantNumber ?? "—"}</div></div>
        <div><div className="label">Project term</div><div>{fmtDate(project?.startDate)} → {fmtDate(project?.endDate)}</div></div>
      </div>

      <div className="space-y-4">
        <SectionTitle action={canEdit ? (
          <form action={uploadSowAction} className="flex items-end gap-2">
            <input type="hidden" name="projectId" value={id} />
            <input type="file" name="file" required accept=".pdf,.doc,.docx,.txt,.md" className="input" style={{ padding: "4px 8px" }} />
            <button className="btn btn-sm" type="submit">Upload &amp; populate</button>
          </form>
        ) : undefined}>Sections</SectionTitle>
        {sections.map((s) => (
          canEdit ? (
            <form key={s.id} action={updateSowSectionAction} className="card p-4 space-y-2">
              <input type="hidden" name="projectId" value={id} />
              <input type="hidden" name="sectionId" value={s.id} />
              <div className="flex items-center gap-2">
                <input name="title" defaultValue={s.title} className="input font-medium" style={{ maxWidth: 360 }} />
                {s.sourceRef === "import" && <Badge tone="info">imported</Badge>}
              </div>
              <textarea name="content" defaultValue={s.content} rows={4} className="textarea" placeholder="Write this section…" />
              <div className="flex justify-end"><button className="btn btn-sm" type="submit">Save section</button></div>
            </form>
          ) : (
            <div key={s.id} className="card p-4">
              <h3 className="font-display font-semibold mb-1">{s.title}</h3>
              <p className="text-sm whitespace-pre-line" style={{ color: s.content ? "var(--fg)" : "var(--muted)" }}>{s.content || "Not yet written."}</p>
            </div>
          )
        ))}
      </div>
    </div>
  );
}
