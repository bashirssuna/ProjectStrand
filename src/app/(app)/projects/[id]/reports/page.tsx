import Link from "next/link";
import { getProjectAccess } from "@/server/policy";
import { q, one } from "@/server/db";
import { generateReportAction, emailReportAction } from "@/app/actions";
import { SectionTitle, Empty, Badge, Field, StatusBadge } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { label } from "@/lib/enums";

export default async function ReportsPage({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ r?: string }> }) {
  const { id } = await params;
  const { r } = await searchParams;
  const access = await getProjectAccess(id);
  const canManage = access.permissions.has("reports.manage");

  const reports = await q<{ id: string; type: string; title: string; status: string; periodLabel: string | null; ai: boolean; createdAt: string }>(
    `SELECT id, type, title, status, period_label AS "periodLabel", generated_by_ai AS ai, created_at AS "createdAt"
     FROM report WHERE project_id=$1 ORDER BY created_at DESC`, [id]
  );

  const selectedId = r ?? reports[0]?.id;
  const selected = selectedId ? await one<{ id: string; title: string; status: string; ai: boolean }>(
    `SELECT id, title, status, generated_by_ai AS ai FROM report WHERE id=$1 AND project_id=$2`, [selectedId, id]
  ) : null;
  const sections = selected ? await q<{ id: string; title: string; content: string }>(
    `SELECT id, title, content FROM report_section WHERE report_id=$1 ORDER BY "order"`, [selected.id]
  ) : [];

  return (
    <div className="grid lg:grid-cols-3 gap-6">
      <div className="space-y-5">
        {canManage && (
          <form action={generateReportAction} className="card p-4 space-y-3">
            <SectionTitle>Generate report</SectionTitle>
            <Field label="Type">
              <select name="type" className="select" defaultValue="quarterly">
                {["monthly", "quarterly", "donor", "internal", "financial", "milestone"].map((t) => <option key={t} value={t}>{label(t)}</option>)}
              </select>
            </Field>
            <Field label="Period"><input name="periodLabel" className="input" placeholder="Q2 2025" defaultValue="Current period" /></Field>
            <input type="hidden" name="projectId" value={id} />
            <button className="btn btn-primary w-full" type="submit">Draft from live data</button>
            <p className="text-xs" style={{ color: "var(--muted)" }}>Pulls activities, indicators, budget and flags into an editable draft.</p>
          </form>
        )}

        <div className="card overflow-hidden">
          <div className="px-4 py-2.5 border-b text-sm font-medium" style={{ borderColor: "var(--border)" }}>All reports</div>
          {reports.length === 0 ? (
            <div className="p-4 text-sm" style={{ color: "var(--muted)" }}>No reports yet.</div>
          ) : reports.map((rep) => (
            <Link key={rep.id} href={`/projects/${id}/reports?r=${rep.id}`}
              className="block px-4 py-3 border-b last:border-0 hover:bg-[var(--surface)]"
              style={{ borderColor: "var(--border)", background: rep.id === selectedId ? "var(--surface)" : undefined }}>
              <div className="text-sm font-medium">{rep.title}</div>
              <div className="flex items-center gap-2 mt-1">
                <StatusBadge status={rep.status} />
                {rep.ai && <Badge tone="info">AI draft</Badge>}
                <span className="text-xs" style={{ color: "var(--muted)" }}>{fmtDateTime(rep.createdAt)}</span>
              </div>
            </Link>
          ))}
        </div>
      </div>

      <div className="lg:col-span-2">
        {!selected ? (
          <Empty title="No report selected" hint="Generate a report or pick one from the list." />
        ) : (
          <div className="card p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <h2 className="font-display text-xl font-semibold">{selected.title}</h2>
                <div className="flex items-center gap-2 mt-1">
                  <StatusBadge status={selected.status} />
                  {selected.ai && <Badge tone="info">AI-generated draft — review before sharing</Badge>}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a href={`/api/reports/${selected.id}/docx`} className="btn btn-sm">Download Word</a>
                {canManage && (
                  <form action={emailReportAction}>
                    <input type="hidden" name="projectId" value={id} />
                    <input type="hidden" name="reportId" value={selected.id} />
                    <button className="btn btn-sm" type="submit">Email to team</button>
                  </form>
                )}
              </div>
            </div>
            <div className="space-y-5">
              {sections.map((s) => (
                <div key={s.id}>
                  <h3 className="font-display font-semibold mb-1">{s.title}</h3>
                  <div className="text-sm whitespace-pre-line leading-relaxed" style={{ color: "var(--fg)" }}>{s.content}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
