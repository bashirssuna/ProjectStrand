import { getProjectAccess } from "@/server/policy";
import { q } from "@/server/db";
import { addFolderAction, uploadDocumentAction } from "@/app/actions";
import { SectionTitle, Empty, Badge, Field } from "@/components/ui";
import { fmtDate, num } from "@/lib/format";
import { label } from "@/lib/enums";

const CATEGORIES = ["proposals", "sows", "budgets", "reports", "approvals", "contracts", "meeting", "evidence", "admin", "general"];

export default async function DocumentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const access = await getProjectAccess(id);
  const canManage = access.permissions.has("documents.manage");

  const folders = await q<{ id: string; name: string; category: string }>(
    `SELECT id, name, category FROM folder WHERE project_id=$1 ORDER BY name`, [id]
  );
  const docs = await q<{ id: string; name: string; docType: string; sizeBytes: number; folderId: string | null; createdAt: string; storageKey: string | null }>(
    `SELECT id, name, doc_type AS "docType", size_bytes AS "sizeBytes", folder_id AS "folderId", created_at AS "createdAt", storage_key AS "storageKey"
     FROM project_document WHERE project_id=$1 ORDER BY created_at DESC`, [id]
  );

  const docsByFolder = new Map<string | null, typeof docs>();
  for (const d of docs) {
    const k = d.folderId ?? null;
    if (!docsByFolder.has(k)) docsByFolder.set(k, []);
    docsByFolder.get(k)!.push(d);
  }

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
      <div className="text-xs whitespace-nowrap" style={{ color: "var(--muted)" }}>
        {d.sizeBytes ? `${num(Math.round(d.sizeBytes / 1024))} KB · ` : ""}{fmtDate(d.createdAt)}
      </div>
    </div>
  );

  return (
    <div className="space-y-7">
      <div>
        <SectionTitle>Repository</SectionTitle>
        {folders.length === 0 && docs.length === 0 ? (
          <Empty title="No documents" hint={canManage ? "Create folders and add documents below." : "No documents uploaded."} />
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

      {canManage && (
        <div className="grid sm:grid-cols-2 gap-5">
          <form action={addFolderAction} className="card p-4 space-y-3">
            <SectionTitle>New folder</SectionTitle>
            <input type="hidden" name="projectId" value={id} />
            <Field label="Name"><input name="name" required className="input" placeholder="Donor reports" /></Field>
            <Field label="Category">
              <select name="category" className="select">{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
            </Field>
            <button className="btn btn-primary" type="submit">Create folder</button>
          </form>

          <form action={uploadDocumentAction} className="card p-4 space-y-3">
            <SectionTitle>Upload document</SectionTitle>
            <input type="hidden" name="projectId" value={id} />
            <Field label="File">
              <input type="file" name="file" required accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg" className="input" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">
                <select name="docType" className="select">{CATEGORIES.map((c) => <option key={c} value={c}>{label(c)}</option>)}</select>
              </Field>
              <Field label="Folder">
                <select name="folderId" className="select">
                  <option value="">Unfiled</option>
                  {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </Field>
            </div>
            <button className="btn btn-primary" type="submit">Upload from my computer</button>
            <p className="text-xs" style={{ color: "var(--muted)" }}>Stored locally in dev; production uses signed S3 uploads. Text is auto-extracted for search.</p>
          </form>
        </div>
      )}
    </div>
  );
}
