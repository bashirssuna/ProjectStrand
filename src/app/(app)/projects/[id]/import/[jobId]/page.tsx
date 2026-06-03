import Link from "next/link";
import { redirect } from "next/navigation";
import { q, one } from "@/server/db";
import { can } from "@/server/policy";
import { applySuggestionsAction } from "@/app/actions";
import { PageHeader, Badge, Empty } from "@/components/ui";
import { label } from "@/lib/enums";
import { money } from "@/lib/format";

const KIND_TONE: Record<string, "ok" | "warn" | "info" | "brand" | "muted"> = {
  meta: "muted", sow_section: "info", objective: "brand", output: "info", activity: "ok", budget_line: "warn",
};

function describe(kind: string, p: Record<string, unknown>): string {
  if (kind === "meta") return `Set ${String(p.field)} → ${String(p.value)}`;
  if (kind === "sow_section") return `${String(p.title)} — ${String(p.content ?? "").slice(0, 90)}…`;
  if (kind === "objective") return `${String(p.code ?? "")} ${String(p.statement)}`;
  if (kind === "output") return `${String(p.code ?? "")} ${String(p.statement)}`;
  if (kind === "activity") return `${p.code ? String(p.code) + " " : ""}${String(p.title)}`;
  if (kind === "budget_line") return `${String(p.description)} — ${money(Number(p.planned ?? 0))}`;
  return JSON.stringify(p);
}

export default async function ReviewPage({ params }: { params: Promise<{ id: string; jobId: string }> }) {
  const { id, jobId } = await params;
  if (!(await can(id, "project.edit"))) redirect(`/projects/${id}`);

  const job = await one<{ fileName: string; docType: string }>(
    `SELECT file_name AS "fileName", doc_type AS "docType" FROM extraction_job WHERE id=$1 AND project_id=$2`, [jobId, id]
  );
  if (!job) redirect(`/projects/${id}/import`);

  const sugs = await q<{ id: string; kind: string; payload: string; confidence: number }>(
    `SELECT id, kind, payload, confidence FROM parsing_suggestion WHERE job_id=$1 ORDER BY kind`, [jobId]
  );
  const parsed = sugs.map((s) => ({ ...s, p: JSON.parse(s.payload) as Record<string, unknown> }));
  const byKind = parsed.reduce<Record<string, typeof parsed>>((acc, s) => {
    (acc[s.kind] ||= []).push(s); return acc;
  }, {});

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Review extracted items"
        subtitle={`From ${job.fileName} · ${label(job.docType)} · ${parsed.length} items found`}
        actions={<Link href={`/projects/${id}/import`} className="btn">Re-import</Link>}
      />

      {parsed.length === 0 ? (
        <Empty title="Nothing extracted" hint="The parser couldn't find structured content. Try a different document or create items manually." />
      ) : (
        <form action={applySuggestionsAction} className="space-y-5">
          <input type="hidden" name="projectId" value={id} />
          <input type="hidden" name="jobId" value={jobId} />

          {Object.entries(byKind).map(([kind, items]) => (
            <div key={kind} className="card overflow-hidden">
              <div className="px-4 py-2.5 border-b flex items-center gap-2" style={{ borderColor: "var(--border)" }}>
                <Badge tone={KIND_TONE[kind] ?? "muted"}>{label(kind)}</Badge>
                <span className="text-xs" style={{ color: "var(--muted)" }}>{items.length} item{items.length > 1 ? "s" : ""}</span>
              </div>
              <div>
                {items.map((s) => (
                  <label key={s.id} className="flex items-start gap-3 px-4 py-2.5 border-b last:border-0 cursor-pointer hover:bg-[var(--surface)]" style={{ borderColor: "var(--border)" }}>
                    <input type="checkbox" name="accept" value={s.id} defaultChecked={s.confidence >= 0.6} className="mt-1" />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm">{describe(kind, s.p)}</div>
                      <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>confidence {Math.round(s.confidence * 100)}%</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div className="flex items-center gap-3">
            <button className="btn btn-primary" type="submit">Accept selected & generate pages</button>
            <Link href={`/projects/${id}`} className="btn">Cancel</Link>
          </div>
        </form>
      )}
    </div>
  );
}
