import { getProjectAccess } from "@/server/policy";
import { q } from "@/server/db";
import { SectionTitle, Empty, Badge } from "@/components/ui";
import { fmtDate, num } from "@/lib/format";
import { label } from "@/lib/enums";
import { blockStaff } from "../_staffblock";
import { deleteDocumentAction, archiveDocumentAction, uploadDocumentAction, addFolderAction } from "@/app/actions";

const DOC_TYPES = ["proposal", "sow", "budget", "report", "contract", "meeting", "evidence", "other"];

export default async function DocumentsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ showArchived?: string; upload?: string }> }) {
  const { id } = await params;
  const sp = await searchParams;
  await blockStaff(id);
  const access = await getProjectAccess(id);
  const canManage = access.permissions.has("documents.manage");
  const showArchived = sp.showArchived === "1";

  const folders = await q<{ id: string; name: string; category: string }>(
    `SELECT id, name, category FROM folder WHERE project_id=$1 ORDER BY name`, [id]
  );
  const docs = await q<{ id: string; name: string; docType: string; sizeBytes: number; folderId: string | null; createdAt: string; storageKey: string | null; archived: boolean }>(
    `SELECT id, name, doc_type AS "docType", size_bytes AS "sizeBytes", folder_id AS "folderId", created_at AS "createdAt", storage_key AS "storageKey", COALESCE(archived,false) AS archived
     FROM project_document WHERE project_id=$1 ORDER BY created_at DESC`, [id]
  );

  const active = docs.filter((d) => !d.archived);
  const archived = docs.filter((d) => d.archived);
  const docsByFolder = new Map<string | null, typeof docs>();
  for (const d of active) {
    const k = d.folderId ?? null;
    if (!docsByFolder.has(k)) docsByFolder.set(k, []);
    docsByFolder.get(k)!.push(d);
  }

  const manageButtons = (d: typeof docs[number]) => (
    <div className="flex items-center gap-1">
      <form action={archiveDocumentAction}>
        <input type="hidden" name="projectId" value={id} />
        <input type="hidden" name="docId" value={d.id} />
        <input type="hidden" name="archived" value={d.archived ? "false" : "true"} />
        <button className="btn btn-sm" type="submit">{d.archived ? "Unarchive" : "Archive"}</button>
      </form>
      <details className="inline-block">
        <summary className="btn btn-sm" style={{ color: "var(--danger)", cursor: "pointer", listStyle: "none" }}>Delete</summary>
        <form action={deleteDocumentAction} className="mt-1">
          <input type="hidden" name="projectId" value={id} />
          <input type="hidden" name="docId" value={d.id} />
          <button className="btn btn-sm" type="submit" style={{ background: "var(--danger)", color: "#fff", border: "none" }}>Confirm delete</button>
        </form>
      </details>
    </div>
  );

  const renderDoc = (d: typeof docs[number]) => (
    <div key={d.id} className="flex items-center justify-between gap-3 py-2 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
      <div className="flex items-center gap-2 min-w-0">
        <span style={{ color: "var(--muted)" }}>📄</span>
        {d.storageKey ? (
          <a href={`/api/files/${d.id}`} className="text-sm truncate hover:underline" style={{ color: "var(--brand)" }}>{d.name}</a>
        ) : (
          <span className="text-sm truncate">{d.name}</span>
        )}
        <Badge tone="muted">{label(d.docType)}</Badge>
      </div>
      <div className="flex items-center gap-3 whitespace-nowrap">
        <span className="text-xs" style={{ color: "var(--muted)" }}>
          {d.sizeBytes ? `${num(Math.round(d.sizeBytes / 1024))} KB · ` : ""}{fmtDate(d.createdAt)}
        </span>
        {canManage && manageButtons(d)}
      </div>
    </div>
  );

  return (
    <div className="space-y-7">
      {canManage && (
        <div className="card p-4">
          <SectionTitle>Add a document</SectionTitle>
          {sp.upload === "ok" && <p className="text-sm mt-1" style={{ color: "var(--ok)" }}>Document uploaded.</p>}
          {sp.upload === "nofile" && <p className="text-sm mt-1" style={{ color: "var(--warn)" }}>Choose a file first.</p>}
          <form action={uploadDocumentAction} className="flex flex-wrap items-end gap-3 mt-2">
            <input type="hidden" name="projectId" value={id} />
            <input type="file" name="file" className="input" required />
            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Folder</label>
              <select name="folderId" className="select">
                <option value="">Unfiled</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Type</label>
              <select name="docType" className="select" defaultValue="other">
                {DOC_TYPES.map((t) => <option key={t} value={t}>{label(t)}</option>)}
              </select>
            </div>
            <button className="btn btn-primary" type="submit">Upload</button>
          </form>
          <form action={addFolderAction} className="flex flex-wrap items-end gap-3 mt-3 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
            <input type="hidden" name="projectId" value={id} />
            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--muted)" }}>New folder name</label>
              <input name="name" className="input" placeholder="e.g. Contracts" required />
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--muted)" }}>Category</label>
              <select name="category" className="select" defaultValue="general">
                {["proposals", "sows", "budgets", "reports", "approvals", "contracts", "evidence", "general"].map((c) => <option key={c} value={c}>{label(c)}</option>)}
              </select>
            </div>
            <button className="btn" type="submit">Create folder</button>
          </form>
        </div>
      )}

      <div>
        <SectionTitle>Repository</SectionTitle>
        {folders.length === 0 && active.length === 0 ? (
          <Empty title="No documents" hint={canManage ? "Upload a document above, or add files from the project sections." : "Documents added in the project sections will appear here."} />
        ) : (
          <div className="space-y-4">
            {folders.map((f) => (
              <div key={f.id} className="card p-4">
                <div className="flex items-center gap-2 mb-2">
                  <span>📁</span>
                  <span className="font-medium">{f.name}</span>
                  <Badge tone="info">{label(f.category)}</Badge>
                </div>
                {(docsByFolder.get(f.id) ?? []).length === 0 ? (
                  <p className="text-xs" style={{ color: "var(--muted)" }}>Empty folder</p>
                ) : (docsByFolder.get(f.id) ?? []).map(renderDoc)}
              </div>
            ))}
            {(docsByFolder.get(null) ?? []).length > 0 && (
              <div className="card p-4">
                <div className="flex items-center gap-2 mb-2"><span>📁</span><span className="font-medium">Unfiled</span></div>
                {(docsByFolder.get(null) ?? []).map(renderDoc)}
              </div>
            )}
          </div>
        )}
      </div>

      {archived.length > 0 && (
        <div>
          <a href={`/projects/${id}/documents${showArchived ? "" : "?showArchived=1"}`} className="text-sm hover:underline" style={{ color: "var(--brand)" }}>
            {showArchived ? "Hide" : "Show"} archived ({archived.length})
          </a>
          {showArchived && (
            <div className="card p-4 mt-2" style={{ opacity: 0.85 }}>
              <div className="flex items-center gap-2 mb-2"><span>🗄️</span><span className="font-medium">Archived</span></div>
              {archived.map(renderDoc)}
            </div>
          )}
        </div>
      )}

      <p className="text-xs" style={{ color: "var(--muted)" }}>
        {canManage
          ? "Documents flow in from their own sections (SOW, work-plan evidence, requisition attachments, risk closure evidence, objectives uploads) and can also be uploaded here. As a document manager you can add, archive, or delete documents."
          : "This repository collects documents from the project sections for viewing and download."}
      </p>
    </div>
  );
}
